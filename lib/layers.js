/**
 * Layer peeling: reproduces the obfuscator machinery found by the analysis inside the
 * sandbox, evaluates every use of a decoded value (decoder calls, constant-table lookups,
 * inlined decoder copies) and inlines the results. Rounds repeat until nothing changes, so
 * layers whose own data was encoded by an outer layer are peeled outside-in.
 *
 * Live layers are judged per use: when every runtime operation on their machinery is
 * reproducible (fixed-argument calls, memoization writes, refs inside inlined decoding
 * expressions), they are peeled like any other layer. Layers whose machinery performs
 * foreign writes, surviving cache reads or aliases keep the freeze fallback: their bindings
 * stay non-static, so nothing of theirs is evaluated or inlined. Uses of outer layers inside
 * a frozen layer are still decoded.
 */
const generate = require('@babel/generator').default;
const bt = require('@babel/types');
const { analyze, isLiteralValue, isDeferredBody, isStandalone } = require('./analysis');
const { run } = require('./sandbox');

const MAX_ROUNDS = 25;
const MAX_RETRIES = 200;

function peelLayers(ast, sandbox, { log = () => {} } = {}) {
    const frozenBindings = new Set(); // declaration nodes of live layers' bindings
    const failedBindings = new Set(); // declaration nodes of bindings that did not reproduce
    const frozen = new Set();         // scope blocks of live layers whose runtime refs are not reproducible
    const decodedLive = new Set();    // scope blocks of live layers decoded in an earlier round
    const failedUnits = new Set();
    const machinery = new Set();      // declaration nodes of every binding a round reproduced
    const stats = { rounds: 0, calls: 0, lookups: 0, expressions: 0, liveLayers: [], decodedLiveLayers: [], failures: [] };

    let round = 1;
    while (round <= MAX_ROUNDS) {
        // Live layers are judged on the analysis itself; bindings dropped because they did
        // not reproduce would otherwise turn working machinery into "callbacks".
        let live = analyze(ast, { forced: frozenBindings });
        for (;;) {
            const fresh = [...live.liveScopes.keys()].filter(block => !frozen.has(block) && !decodedLive.has(block));
            if (!fresh.length) break;
            for (const block of fresh) {
                const safety = live.liveSafety.get(block) || { safe: false, unsafe: ['unclassified'] };
                if (safety.safe) {
                    // Every runtime operation is reproducible; peel the layer like any other.
                    decodedLive.add(block);
                    stats.decodedLiveLayers.push(describe(block));
                    continue;
                }
                frozen.add(block);
                stats.liveLayers.push(describe(block));
                log(`  Live layer ${describe(block)}: used from callbacks by ` +
                    [...live.liveScopes.get(block)].map(b => b.identifier.name).join(', ') + '; left as is' +
                    (safety.unsafe.length ? ` (${safety.unsafe.slice(0, 4).join(', ')}${safety.unsafe.length > 4 ? ', ...' : ''})` : '') + '.');
            }
            freezeBindings(live, frozen, frozenBindings);
            live = analyze(ast, { forced: frozenBindings });
        }
        const r = failedBindings.size
            ? analyze(ast, { forced: new Set([...frozenBindings, ...failedBindings]) })
            : live;

        const plan = buildPlan(r, failedUnits);
        stats.rounds = round;
        log(`  Round ${round}: ${r.decoders.size} decoders, ${r.stores.size} tables, ` +
            `${plan.steps.filter(st => st.kind === 'unit').length} machinery statements, ${plan.targets.length} uses to evaluate`);
        if (!plan.targets.length) break;

        const ctx = sandbox.context();
        let outcome;
        try {
            outcome = evaluate(ctx, plan);
        } finally {
            ctx.release();
        }

        // Machinery that cannot be reproduced, or an inlined copy that does not evaluate,
        // invalidates the analysis: keep the affected bindings non-static and redo the round.
        // Only the first failure is a cause; later ones may just follow from it, and are
        // judged again on the new analysis.
        const failure = outcome.failure;
        if (failure) {
            if (failure.kind === 'unit') failedUnits.add(failure.path.node);
            for (const b of failure.bindings) failedBindings.add(b.identifier);
            const what = `${failure.kind === 'unit' ? 'statement' : 'expression'} at line ${failure.path.node.loc?.start.line}` +
                (failure.error ? ` (${failure.error})` : '');
            stats.failures.push(what);
            log(`    Not reproducible, retrying without: ${what}`);
            if (stats.failures.length >= MAX_RETRIES) break;
            continue;
        }

        // Only machinery whose reproduction worked counts as machinery.
        for (const b of r.needed) machinery.add(b.identifier);
        const applied = apply(plan, outcome.values);
        stats.calls += applied.calls;
        stats.lookups += applied.lookups;
        stats.expressions += applied.expressions;
        log(`    Inlined ${applied.calls} calls, ${applied.lookups} table lookups, ${applied.expressions} inlined decoder copies`);
        if (!applied.calls && !applied.lookups && !applied.expressions) break;
        round++;
    }
    // Bindings that did not reproduce stay non-static for every later phase too.
    const forced = new Set([...frozenBindings, ...failedBindings]);
    // Every scope seen as live (frozen or decoded): statements holding them are not observed
    // by the unmangler, which runs code against stub host objects.
    const liveScopes = new Set([...frozen, ...decodedLive]);
    return { stats, frozen, forced, machinery, liveScopes };
}

function describe(block) {
    const name = block.id ? block.id.name + '()' : block.type;
    return `${name} (lines ${block.loc?.start.line}-${block.loc?.end.line})`;
}

function isInside(path, blocks) {
    return blocks.has(path.node) || !!path.findParent(p => blocks.has(p.node));
}

// Every binding declared inside a frozen block is kept non-static, except plain aliases of
// outer machinery (`const n = b`): those only name an outer layer's decoder.
function freezeBindings(r, frozen, forced) {
    const outside = (b) => !isInside(b.scope.path, frozen);
    const aliasOfOutside = (b) => {
        const seen = new Set();
        while (b && !seen.has(b)) {
            seen.add(b);
            if (outside(b)) return true;
            if (!b.path.isVariableDeclarator() || !bt.isIdentifier(b.path.node.init) || b.constantViolations.length) return false;
            b = b.path.scope.getBinding(b.path.node.init.name);
        }
        return false;
    };
    for (const b of r.bindings) {
        if (!outside(b) && !aliasOfOutside(b)) forced.add(b.identifier);
    }
}

// ----------------------------------------------------------------------------
// Plan: which statements reproduce the machinery, and which uses to evaluate
// ----------------------------------------------------------------------------

// Statements that reproduce `needed`: their units that only touch static bindings, minus
// units nested in other units (they run as part of them), plus copies of functions declared
// inside units when everything they close over is reachable from the top level.
function selectUnits(r, needed, failedUnits) {
    const unitPaths = new Map(); // node -> path
    for (const b of needed) {
        if (b.kind === 'param') continue;
        for (const u of r.unitsOf.get(b) || []) {
            if (!failedUnits.has(u.node) && r.isStaticNode(u.node)) unitPaths.set(u.node, u);
        }
    }
    const top = [...unitPaths.values()].filter(u => !u.findParent(p => unitPaths.has(p.node)));

    const accessible = new Set();
    for (const u of top) for (const b of declaredBy(u)) accessible.add(b);
    const copies = [];
    for (let changed = true; changed;) {
        changed = false;
        for (const b of needed) {
            if (accessible.has(b) || !b.path.isFunctionDeclaration() || !unitPaths.has(b.path.node)) continue;
            if ([...r.freeOf(b.path.node)].every(d => d === b || accessible.has(d))) {
                accessible.add(b);
                copies.push(b.path);
                changed = true;
            }
        }
    }

    // Unique names for every binding the sandbox code refers to.
    const names = new Map();
    const prefix = unusedPrefix(r.programPath);
    for (const b of [...needed, ...accessible]) {
        if (b.kind !== 'param' && !names.has(b)) names.set(b, prefix + names.size);
    }
    return { unitPaths, top, accessible, copies, names };
}

function buildPlan(r, failedUnits) {
    const isStatic = (b) => !!b && r.staticSet.has(b);
    const { unitPaths, top, accessible, copies, names } = selectUnits(r, r.needed, failedUnits);

    // Uses of decoded values.
    const targets = [];
    const provisionalOwners = new Map(); // expression node -> Set<Binding>
    for (const [b, nodes] of r.provisional) {
        if (!r.needed.has(b)) continue;
        for (const node of nodes) {
            if (!provisionalOwners.has(node)) provisionalOwners.set(node, new Set());
            provisionalOwners.get(node).add(b);
        }
    }

    // Value expression for a fixed argument, or null.
    const argReady = (p) => {
        if (isLiteralValue(p.node)) return true;
        if (p.isMemberExpression() && p.node.computed && p.get('object').isIdentifier() && isLiteralValue(p.node.property)) {
            const b = p.scope.getBinding(p.node.object.name);
            return accessible.has(b);
        }
        return false;
    };

    // Uses in the synchronous part of a reproduced statement run while the machinery is
    // still being set up (a rotator calling the decoder while it shuffles the array): their
    // values differ from the final ones, so they stay. Function bodies run later.
    const duringSetup = (path) => {
        for (let prev = path, cur = path.parentPath; cur; prev = cur, cur = cur.parentPath) {
            if (isDeferredBody(cur, prev)) return false;
            if (unitPaths.has(cur.node)) return true;
        }
        return false;
    };

    r.programPath.traverse({
        enter(path) {
            const node = path.node;
            if ((path.isCallExpression() || path.isMemberExpression()) && duringSetup(path)) return;
            if (provisionalOwners.has(node)) {
                // Inside a reproduced statement it already runs as part of that statement.
                if (path.findParent(p => unitPaths.has(p.node))) return;
                // Only decoding work is inlined: the expression must either contain the write
                // it computes, or be a self-contained IIFE call whose result replaces it. An
                // application call that merely consumes a decoder value (`console.log(g(i))`)
                // is neither and stays.
                const owners = provisionalOwners.get(node);
                const writesThroughMember = (ref) => {
                    const member = ref.parentPath;
                    return member.isMemberExpression() && member.node.object === ref.node && isWriteTarget(member);
                };
                const isFill = [...owners].some(b => {
                    const violations = new Set(b.constantViolations);
                    return [...b.referencePaths, ...b.constantViolations].some(ref =>
                        ref.node.start >= node.start && ref.node.end <= node.end &&
                        (violations.has(ref) || writesThroughMember(ref)));
                });
                const isIifeCall = node.type === 'CallExpression' &&
                    (node.callee.type === 'FunctionExpression' || node.callee.type === 'ArrowFunctionExpression');
                if (!isFill && !isIifeCall) return;
                const free = [...r.freeBindingsOf(path)];
                // A function-scoped local the expression itself assigns before reading (a
                // trap's `s = d[69]` inside a copied decoder) can be declared empty in the
                // sandbox: no other reproduced code reads it.
                const locals = free.filter(b => !accessible.has(b) && b.kind === 'var' &&
                    b.path.isVariableDeclarator() && assignsBeforeReads(path, b));
                const ok = free.every(b => accessible.has(b) || locals.includes(b));
                targets.push({ kind: 'expression', path, ok, bindings: provisionalOwners.get(node), locals });
                return;
            }
            if (path.isCallExpression() && path.get('callee').isIdentifier()) {
                const b = path.scope.getBinding(node.callee.name);
                if (!isStatic(b)) return;
                const decoder = r.resolveAlias(b);
                if (!r.decoders.has(decoder) || !accessible.has(decoder)) return;
                if (!node.arguments.length) return;
                const tree = choiceTree(path.get('arguments'));
                if (!leaves(tree).every(args => args.every(argReady))) return;
                targets.push({ kind: 'call', path, decoder, tree });
                return;
            }
            if (path.isMemberExpression() && node.computed && path.get('object').isIdentifier() && isLiteralValue(node.property)) {
                const b = path.scope.getBinding(node.object.name);
                if (!isStatic(b)) return;
                const store = r.resolveAlias(b);
                if (!r.stores.has(store) || !accessible.has(store)) return;
                if (isWriteTarget(path)) return;
                if (path.parentPath.isCallExpression() && path.parentPath.node.callee === node) return;
                targets.push({ kind: 'lookup', path, store });
            }
        },
    });

    // Locals of planned expressions get their own sandbox names, so two distinct `var`s with
    // the same name in different callbacks cannot share one slot.
    const localPrefix = unusedPrefix(r.programPath);
    for (const t of targets) {
        for (const b of t.locals || []) {
            if (!names.has(b)) names.set(b, localPrefix + names.size);
        }
    }

    // Machinery statements and inlined decoder copies run interleaved in execution order:
    // a copy may rotate or fill state that later statements rely on, and vice versa.
    // A statement that fails takes down what it declares or writes, and the bindings it is a
    // setup statement of (a rotator writes nothing, but the array it shuffles is wrong).
    const owners = new Map();
    for (const b of r.needed) {
        for (const u of r.unitsOf.get(b) || []) {
            if (!owners.has(u.node)) owners.set(u.node, new Set());
            owners.get(u.node).add(b);
        }
    }
    const steps = [
        ...top.map(path => ({
            kind: 'unit',
            path,
            bindings: [...new Set([...bindingsTouchedBy(path, r), ...(owners.get(path.node) || [])])],
        })),
        ...targets.filter(t => t.kind === 'expression'),
    ].sort((a, b) => byExecutionOrder(a.path, b.path));

    return { steps, copies, targets, names };
}

// Function declarations first (they are hoisted in the original scopes), then outer scopes
// before inner ones, and source order within a scope.
function byExecutionOrder(a, b) {
    return (b.isFunctionDeclaration() - a.isFunctionDeclaration()) || depth(a) - depth(b) || a.node.start - b.node.start;
}

function depth(path) {
    let d = 0;
    for (let p = path.parentPath; p; p = p.parentPath) if (p.isScopable()) d++;
    return d;
}

function declaredBy(unit) {
    const scope = unit.parentPath.scope;
    const out = [];
    if (unit.isFunctionDeclaration()) {
        out.push(scope.getBinding(unit.node.id.name));
    } else if (unit.isVariableDeclaration()) {
        for (const name of Object.keys(unit.getBindingIdentifiers())) out.push(scope.getBinding(name));
    }
    return out.filter(Boolean);
}

// Bindings a unit declares or writes: what becomes unknown if it cannot run.
function bindingsTouchedBy(unit, r) {
    const out = new Set(declaredBy(unit));
    for (const b of r.needed) {
        if (b.constantViolations.some(v => v === unit || v.isDescendant(unit))) out.add(b);
    }
    return out;
}

function unusedPrefix(programPath) {
    const used = new Set();
    programPath.traverse({ Identifier(p) { used.add(p.node.name); } });
    let prefix = '__z';
    while ([...used].some(n => n.startsWith(prefix))) prefix += '_';
    return prefix;
}

// `f(c ? 1 : 2)` is evaluated as `c ? f(1) : f(2)`.
function choiceTree(args) {
    const i = args.findIndex(a => a.isConditionalExpression());
    if (i < 0) return { args };
    const a = args[i];
    const swap = (p) => args.map((x, j) => (j === i ? p : x));
    return { test: a.node.test, cons: choiceTree(swap(a.get('consequent'))), alt: choiceTree(swap(a.get('alternate'))) };
}

function leaves(tree) {
    return tree.args ? [tree.args] : [...leaves(tree.cons), ...leaves(tree.alt)];
}

// Positions where a member expression is written to or deleted rather than read.
function isWriteTarget(path) {
    const parent = path.parentPath;
    if (parent.isAssignmentExpression() && parent.node.left === path.node) return true;
    if (parent.isUpdateExpression()) return true;
    if (parent.isUnaryExpression({ operator: 'delete' })) return true;
    if ((parent.isForInStatement() || parent.isForOfStatement()) && parent.node.left === path.node) return true;
    return false;
}

// Does the expression establish the binding's value before reading it? Locals of the
// enclosing function have no value in the sandbox, so their first use must be the write.
function assignsBeforeReads(exprPath, binding) {
    let assign = Infinity;
    let read = Infinity;
    const visit = (p) => {
        if (!p.isIdentifier() || p.node.name !== binding.identifier.name) return;
        if (p.scope.getBinding(p.node.name) !== binding) return;
        const parent = p.parentPath;
        if (parent.isAssignmentExpression({ operator: '=' }) && parent.node.left === p.node) {
            assign = Math.min(assign, p.node.start);
        } else {
            read = Math.min(read, p.node.start);
        }
    };
    if (exprPath.isIdentifier()) visit(exprPath);
    exprPath.traverse({ Identifier: visit });
    return assign !== Infinity && assign < read;
}

// ----------------------------------------------------------------------------
// Evaluation
// ----------------------------------------------------------------------------

// Generates code with every planned binding renamed to its unique sandbox name.
function withRenamed(names, fn) {
    const renamed = [];
    const rename = (node, name) => {
        if (node && bt.isIdentifier(node)) {
            renamed.push([node, node.name]);
            node.name = name;
        }
    };
    for (const [b, name] of names) {
        const original = b.identifier.name;
        const nodes = new Set([b.identifier, ...b.referencePaths.map(ref => ref.node)]);
        for (const v of b.constantViolations) {
            const ids = v.isFunctionDeclaration() ? [v.node.id] : v.getBindingIdentifiers(true)[original] || [];
            for (const id of ids) nodes.add(id);
        }
        for (const node of nodes) rename(node, name);
    }
    try {
        return fn();
    } finally {
        for (let i = renamed.length - 1; i >= 0; i--) renamed[i][0].name = renamed[i][1];
    }
}

const code = (node) => generate(node, { comments: false }).code;

function evaluate(ctx, plan) {
    // Own properties only: a cache slot not filled yet must not read as an inherited value.
    run(ctx, 'globalThis.__own = (o, k) => Object.prototype.hasOwnProperty.call(Object(o), k) ? o[k] : {};');
    // Locals the planned expressions assign themselves; in the original they are hoisted
    // vars of the enclosing function, which is not reproduced.
    const locals = new Set();
    for (const t of plan.targets) if (t.locals) for (const b of t.locals) locals.add(plan.names.get(b));
    if (locals.size) run(ctx, `var ${[...locals].join(', ')};`);
    const guarded = (e) => `(() => { try { return __encode((${e})); } catch (e) { return null; } })()`;

    const { stepCode, copyCode, exprs } = withRenamed(plan.names, () => ({
        stepCode: plan.steps.map(step => (step.kind === 'unit' || step.ok) ? code(step.path.node) : null),
        copyCode: plan.copies.map(p => code(p.node)),
        exprs: plan.targets.map(t => {
            if (t.kind === 'expression') return null;
            if (t.kind === 'lookup') return `__own(${plan.names.get(t.store)}, ${code(t.path.node.property)})`;
            const callee = plan.names.get(t.decoder);
            return leaves(t.tree).map(args => `${callee}(${args.map(a => code(a.node)).join(', ')})`);
        }),
    }));

    if (copyCode.length) run(ctx, copyCode.join('\n'));
    const stepValues = new Map(); // expression target -> encoded value
    for (const [i, step] of plan.steps.entries()) {
        if (step.kind === 'unit') {
            if (!isStandalone(step.path)) return { failure: { ...step, error: 'cannot run outside its function' } };
            try {
                run(ctx, stepCode[i]);
            } catch (err) {
                return { failure: { ...step, error: String(err && err.message || err).slice(0, 120) } };
            }
        } else {
            const value = stepCode[i] === null ? null : JSON.parse(run(ctx, `JSON.stringify(${guarded(stepCode[i])})`));
            if (!valueNode(value, step.path)) return { failure: step };
            stepValues.set(step, value);
        }
    }

    // One batched round trip for the rest; identical expressions are evaluated once.
    const distinct = new Map();
    for (const e of exprs) for (const x of [].concat(e || [])) if (!distinct.has(x)) distinct.set(x, distinct.size);
    const list = [...distinct.keys()];
    const results = JSON.parse(run(ctx, `JSON.stringify([${list.map(guarded).join(',\n')}])`));

    const values = plan.targets.map((t, i) => {
        if (t.kind === 'expression') return stepValues.get(t);
        return Array.isArray(exprs[i]) ? exprs[i].map(e => results[distinct.get(e)]) : results[distinct.get(exprs[i])];
    });
    return { failure: null, values };
}

// A sandbox context holding the static machinery `roots` depend on, and the renaming under
// which other code of the program can run against it.
function machineryContext(r, roots, sandbox) {
    const needed = new Set();
    const stack = [...roots];
    while (stack.length) {
        const b = stack.pop();
        if (!b || needed.has(b) || !r.staticSet.has(b)) continue;
        needed.add(b);
        for (const d of r.depsOf.get(b) || []) stack.push(d);
    }
    const { top, copies, names } = selectUnits(r, needed, new Set());
    const ctx = sandbox.context();
    const units = top.sort(byExecutionOrder);
    const { unitCode, copyCode } = withRenamed(names, () => ({
        unitCode: units.map(u => code(u.node)),
        copyCode: copies.map(p => code(p.node)),
    }));
    if (copyCode.length) run(ctx, copyCode.join('\n'));
    for (const c of unitCode) {
        try {
            run(ctx, c);
        } catch (err) {
            // Machinery the statements under observation do not reach is not needed anyway.
        }
    }
    return { ctx, names, codeOf: (nodes) => withRenamed(names, () => nodes.map(code)) };
}

function valueNode(encoded, path) {
    if (!encoded) return null;
    const [tag, v] = encoded;
    switch (tag) {
        case 's': return bt.stringLiteral(v);
        case 'b': return bt.booleanLiteral(v);
        case 'l': return bt.nullLiteral();
        case 'u': return path.scope.getBinding('undefined')
            ? bt.unaryExpression('void', bt.numericLiteral(0))
            : bt.identifier('undefined');
        case 'n': {
            const n = Number(v);
            if (v === '-0' || !Number.isFinite(n)) return null;
            return n < 0 ? bt.unaryExpression('-', bt.numericLiteral(-n)) : bt.numericLiteral(n);
        }
        default: return null;
    }
}

function apply(plan, values) {
    const counts = { calls: 0, lookups: 0, expressions: 0 };
    const replaced = new Set(); // paths (a replaced path holds its new node)
    // Outer expressions first; anything inside a replaced expression is gone with it.
    const order = plan.targets.map((t, i) => i).sort((a, b) =>
        depthOf(plan.targets[a].path) - depthOf(plan.targets[b].path));
    for (const i of order) {
        const t = plan.targets[i];
        if (replaced.has(t.path) || t.path.findParent(p => replaced.has(p))) continue;
        let node;
        if (t.kind === 'call') {
            const results = values[i];
            let k = 0;
            const build = (tree) => {
                if (tree.args) return valueNode(results[k++], t.path);
                const cons = build(tree.cons), alt = build(tree.alt);
                return cons && alt ? bt.conditionalExpression(bt.cloneNode(tree.test, true), cons, alt) : null;
            };
            node = build(t.tree);
        } else {
            node = valueNode(values[i], t.path);
        }
        if (!node) continue;
        replaced.add(t.path);
        t.path.replaceWith(node);
        counts[t.kind === 'call' ? 'calls' : t.kind === 'lookup' ? 'lookups' : 'expressions']++;
    }
    return counts;
}

function depthOf(path) {
    let d = 0;
    for (let p = path.parentPath; p; p = p.parentPath) d++;
    return d;
}

module.exports = { peelLayers, isInside, machineryContext };
