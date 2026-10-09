/**
 * Static analysis: separates obfuscator machinery from application code using data flow
 * only — no identifier names, string contents or code positions are assumed.
 *
 * A binding is "static" when its value can be reproduced outside the program:
 *   - it is written only by synchronous initialization code of its own scope (body
 *     statements and the IIFEs inside them), or by functions that application code only
 *     ever calls with literal arguments;
 *   - application code only reads it: calls it with literals, reads members of it, or
 *     aliases it (`const x = b`).
 * A "decoder" is a static function taking arguments whose closure embeds string data.
 * A "store" is a static binding read with literal keys (`l[5]`) that belongs to decoder
 * machinery. Their literal uses can be evaluated in a sandbox and inlined.
 * A layer is "live" when its machinery is also used from callbacks (handlers, timers): code
 * that keeps operating it at run time. Live scopes are recorded so their statements are not
 * executed during observation; their uses are decoded like any other wherever the plan can
 * reproduce them.
 */
const traverse = require('@babel/traverse').default;
const bt = require('@babel/types');

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function isLiteralValue(node) {
    return bt.isStringLiteral(node) || bt.isNumericLiteral(node) || bt.isBooleanLiteral(node) ||
        bt.isNullLiteral(node) ||
        (bt.isUnaryExpression(node, { operator: '-' }) && bt.isNumericLiteral(node.argument));
}

// Argument shapes whose value is fixed once constants are known: literal choices and
// literal-key lookups such as `l[235]` (the lookup target is checked separately).
function isFixedArgShape(node) {
    if (bt.isConditionalExpression(node)) return isFixedArgShape(node.consequent) && isFixedArgShape(node.alternate);
    if (bt.isMemberExpression(node) && node.computed && bt.isIdentifier(node.object)) return isLiteralValue(node.property);
    return isLiteralValue(node);
}

// How a reference uses its binding:
//   call  — callee of a call                     B(...)
//   alias — initializer of `const x = B`
//   read  — member read or typeof                B[k], B.k, typeof B
//   other — anything else (passed as a value, method call, write through a member, ...)
function referenceKind(ref) {
    const parent = ref.parentPath;
    const node = ref.node;
    if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.callee === node) return 'call';
    if (parent.isVariableDeclarator() && parent.node.init === node && bt.isIdentifier(parent.node.id)) return 'alias';
    if (parent.isUnaryExpression({ operator: 'typeof' })) return 'read';
    if (parent.isBinaryExpression({ operator: 'in' }) && parent.node.right === node) return 'read';
    if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === node) {
        const grand = parent.parentPath;
        if ((grand.isCallExpression() || grand.isOptionalCallExpression()) && grand.node.callee === parent.node) return 'other';
        if (grand.isAssignmentExpression() && grand.node.left === parent.node) return 'other';
        if (grand.isUpdateExpression() || grand.isUnaryExpression({ operator: 'delete' })) return 'other';
        if ((grand.isForInStatement() || grand.isForOfStatement()) && grand.node.left === parent.node) return 'other';
        return 'read';
    }
    return 'other';
}

// A use of the binding's decoded value rather than its machinery.
function isValueUse(ref) {
    const kind = referenceKind(ref);
    if (kind === 'alias') return true;
    if (kind === 'call') {
        const args = ref.parentPath.node.arguments;
        return args.length > 0 && args.every(isFixedArgShape);
    }
    if (kind === 'read') {
        const parent = ref.parentPath;
        return parent.isMemberExpression() && parent.node.computed && isLiteralValue(parent.node.property);
    }
    return false;
}

// Direct child statement of a statement list (program, block, switch case).
function isBodyStatement(path) {
    const parent = path.parentPath;
    return !!parent && (path.listKey === 'body' || path.listKey === 'consequent') &&
        (parent.isProgram() || parent.isBlockStatement() || parent.isStaticBlock() || parent.isSwitchCase());
}

// Function invoked in place: (function () {...})(), (() => {...})()
function isIife(fnPath) {
    const parent = fnPath.parentPath;
    return (parent.isCallExpression() || parent.isNewExpression()) && parent.node.callee === fnPath.node;
}

// Coming up from `child`, does `fnPath` hold code that runs only when the function is
// called later? IIFEs run in place, and computed method keys run in the enclosing code.
function isDeferredBody(fnPath, child) {
    return fnPath.isFunction() && !isIife(fnPath) && child.key !== 'key' && child.listKey !== 'decorators';
}

// A statement that can run on its own, outside the function it sits in (as the sandbox runs
// machinery statements): it does not return, yield or await for that function, break or
// continue its loops, or use its `this` or `arguments`.
const standaloneCache = new WeakMap();
function isStandalone(stmt) {
    if (standaloneCache.has(stmt.node)) return standaloneCache.get(stmt.node);
    const within = (p) => !!p && (p === stmt || p.isDescendant(stmt));
    const ownFunction = (p) => within(p.getFunctionParent());
    const ownThis = (p) => within(p.findParent(q => q.isFunction() && !q.isArrowFunctionExpression()));
    let ok = !(stmt.isReturnStatement() || stmt.isBreakStatement() || stmt.isContinueStatement());
    if (ok) {
        stmt.traverse({
            'ReturnStatement|YieldExpression|AwaitExpression'(p) {
                if (!ownFunction(p)) { ok = false; p.stop(); }
            },
            'BreakStatement|ContinueStatement'(p) {
                const label = p.node.label && p.node.label.name;
                const target = p.findParent(q => label
                    ? q.isLabeledStatement() && q.node.label.name === label
                    : q.isLoop() || (p.isBreakStatement() && q.isSwitchStatement()));
                if (!within(target)) { ok = false; p.stop(); }
            },
            ThisExpression(p) {
                if (!ownThis(p)) { ok = false; p.stop(); }
            },
            Identifier(p) {
                if (p.node.name === 'arguments' && p.isReferencedIdentifier() && !p.scope.getBinding('arguments') && !ownThis(p)) {
                    ok = false;
                    p.stop();
                }
            },
        });
    }
    standaloneCache.set(stmt.node, ok);
    return ok;
}

// `B[key] = value` with a computed key.
function isMemoWrite(ref) {
    const member = ref.parentPath;
    const assign = member.parentPath;
    return member.isMemberExpression() && member.node.object === ref.node && member.node.computed &&
        assign.isAssignmentExpression({ operator: '=' }) && assign.node.left === member.node;
}

// Any write through a member: assignment, update, delete, for-in/of target. The contents of
// such a binding are not part of the reproduced value.
function isMemberWrite(ref) {
    const member = ref.parentPath;
    if (!member.isMemberExpression() || member.node.object !== ref.node) return false;
    const parent = member.parentPath;
    return (parent.isAssignmentExpression() && parent.node.left === member.node) ||
        parent.isUpdateExpression() ||
        parent.isUnaryExpression({ operator: 'delete' }) ||
        ((parent.isForInStatement() || parent.isForOfStatement()) && parent.node.left === member.node);
}

// Slots where obfuscated code places decoded values: call/new arguments, computed member
// properties and computed object/class keys.
function isValueSlot(path) {
    const parent = path.parentPath;
    if (!parent) return false;
    if ((parent.isCallExpression() || parent.isNewExpression() || parent.isOptionalCallExpression()) && path.listKey === 'arguments') return true;
    if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.computed && path.key === 'property') return true;
    if ((parent.isObjectProperty() || parent.isObjectMethod() || parent.isClassMethod() || parent.isClassProperty()) &&
        parent.node.computed && path.key === 'key') return true;
    // `(cond ? ... : ...) in obj`: the conditional is the value position being tested for
    // membership. Only the conditional is a slot, not the `in` itself: its right side may be
    // application state (`in m` over an empty helper function) that must stay untouched.
    if (path.isConditionalExpression() && parent.isBinaryExpression({ operator: 'in' }) && parent.node.left === path.node) return true;
    return false;
}

// The value expression enclosing `path` (e.g. an inlined decoder IIFE used as a key),
// reached without entering code that runs later. Writes inside it are provisional: they
// disappear if the expression is inlined, and are re-checked if it is not. A reference that
// itself fills a slot (machinery passed as an argument) is consumed by the expression around
// it, e.g. the rotator IIFE it is passed to.
function consumerExpressionOf(path) {
    for (let prev = path, cur = path.parentPath; cur; prev = cur, cur = cur.parentPath) {
        if (isDeferredBody(cur, prev)) return null;
        if (cur.isProgram()) return null;
        if (isValueSlot(cur)) return cur;
    }
    return null;
}

// ----------------------------------------------------------------------------
// Analysis
// ----------------------------------------------------------------------------

function analyze(ast, { forced = new Set() } = {}) {
    traverse.cache.clear();
    let programPath = null;
    traverse(ast, { Program(path) { programPath = path; path.stop(); } });

    // Every binding, once.
    const bindings = [];
    const seenScopes = new Set();
    const collect = (scope) => {
        if (seenScopes.has(scope)) return;
        seenScopes.add(scope);
        for (const name of Object.keys(scope.bindings)) bindings.push(scope.bindings[name]);
    };
    collect(programPath.scope);
    traverse(ast, { Scopable(path) { collect(path.scope); } });

    // Free variables of every function, declarator and body statement: walk each
    // reference up to its binding's scope, recording the binding on every node crossed.
    // Also remember, per reference, the body statement of the binding's scope holding it.
    // `structural` keeps only references that need the binding's machinery itself, leaving
    // out uses of decoded values (literal-argument calls, literal-key reads, aliases).
    const free = new Map();
    const structural = new Map();
    const unitOf = new Map();
    const add = (map, node, binding) => {
        let set = map.get(node);
        if (!set) map.set(node, (set = new Set()));
        set.add(binding);
    };
    for (const binding of bindings) {
        const stop = binding.scope.path;
        const writes = new Set(binding.constantViolations);
        for (const ref of [...binding.referencePaths, ...binding.constantViolations]) {
            const isStructural = writes.has(ref) || !isValueUse(ref);
            const record = (node) => {
                add(free, node, binding);
                if (isStructural) add(structural, node, binding);
            };
            let unit = isBodyStatement(ref) ? ref : null;
            if (unit) record(ref.node);
            for (let cur = ref.parentPath; cur && cur !== stop; cur = cur.parentPath) {
                if (cur.isFunction() || cur.isVariableDeclarator() || cur.isClass()) record(cur.node);
                if (isBodyStatement(cur)) {
                    record(cur.node);
                    unit = cur;
                }
            }
            unitOf.set(ref, unit);
        }
    }
    const freeOf = (node) => free.get(node) || EMPTY;
    const structuralOf = (node) => structural.get(node) || EMPTY;

    const bindingOfFn = new Map();
    for (const b of bindings) {
        if (b.path.isFunctionDeclaration()) bindingOfFn.set(b.path.node, b);
        else if (b.path.isVariableDeclarator() && bt.isFunction(b.path.node.init)) bindingOfFn.set(b.path.node.init, b);
    }

    // Loop/catch variables, classes and destructuring never qualify. Parameters qualify
    // only while their function is machinery (checked in stillStatic): their values then
    // come from literal-argument calls or from machinery itself.
    const candidate = (binding) => {
        const p = binding.path;
        if (binding.kind === 'param') return p.isIdentifier();
        if (!['var', 'let', 'const', 'hoisted'].includes(binding.kind)) return false;
        if (p.isClassDeclaration() || p.isCatchClause()) return false;
        if (p.isVariableDeclarator()) {
            if (!bt.isIdentifier(p.node.id)) return false;
            const decl = p.parentPath;
            const loop = decl.parentPath;
            if ((loop.isForStatement() && loop.node.init === decl.node) ||
                ((loop.isForInStatement() || loop.isForOfStatement()) && loop.node.left === decl.node)) return false;
        }
        return true;
    };
    const staticSet = new Set(bindings.filter(candidate));
    // Call arguments fixed by literals and lookups into static bindings.
    const isFixedArg = (path) => {
        if (path.isConditionalExpression()) return isFixedArg(path.get('consequent')) && isFixedArg(path.get('alternate'));
        if (path.isMemberExpression() && isFixedArgShape(path.node)) {
            return staticSet.has(path.scope.getBinding(path.node.object.name));
        }
        return isLiteralValue(path.node);
    };
    // A callee that never reads its arguments behaves the same whatever it is passed
    // (e.g. a no-op used to group expressions), so any arguments are as good as fixed.
    const ignoresArgs = new Map();
    const ignoresArguments = (binding) => {
        if (ignoresArgs.has(binding)) return ignoresArgs.get(binding);
        let fn = binding.path.isFunctionDeclaration() ? binding.path
            : binding.path.isVariableDeclarator() && binding.path.get('init').isFunction() ? binding.path.get('init') : null;
        let result = !!fn && fn.node.params.every(p => bt.isIdentifier(p) && !fn.scope.getBinding(p.name)?.referenced);
        if (result) {
            fn.traverse({
                Identifier(p) {
                    if (p.node.name === 'arguments' && p.isReferencedIdentifier() && !p.scope.getBinding('arguments')) {
                        result = false;
                        p.stop();
                    }
                },
            });
        }
        ignoresArgs.set(binding, result);
        return result;
    };
    // A function that ignores its arguments and whose only effect is replacing itself with
    // an empty function (`function F() { F = function () {}; }`): calling it does nothing.
    const isNoop = (binding) => {
        if (!binding.path.isFunctionDeclaration() || !ignoresArguments(binding)) return false;
        const isEmptyFn = (n) => bt.isFunction(n) && bt.isBlockStatement(n.body) && n.body.body.length === 0;
        return binding.path.node.body.body.every(stmt =>
            bt.isExpressionStatement(stmt) && bt.isAssignmentExpression(stmt.expression, { operator: '=' }) &&
            bt.isIdentifier(stmt.expression.left, { name: binding.identifier.name }) && isEmptyFn(stmt.expression.right)) &&
            binding.constantViolations.every(v => v.isDescendant(binding.path));
    };
    const hasFixedArgs = (callPath, callee) =>
        (callee && ignoresArguments(callee)) || callPath.get('arguments').every(isFixedArg);

    const isStaticNode = (node) => {
        for (const b of freeOf(node)) if (!staticSet.has(b)) return false;
        return true;
    };

    // A function is machinery when it is static and only machinery or literal-argument
    // calls can reach it: either it is bound to a static binding, or it is created by
    // machinery code and stored (returned, assigned to a static target) rather than handed
    // to some other callee as a callback.
    const machineryMemo = new Map();
    function isMachineryFunction(fnPath) {
        const node = fnPath.node;
        if (!isStaticNode(node)) return false;
        const bound = bindingOfFn.get(node);
        if (bound) return staticSet.has(bound);
        if (machineryMemo.has(node)) return machineryMemo.get(node);
        machineryMemo.set(node, false); // cycle guard
        const result = storedByMachinery(fnPath);
        machineryMemo.set(node, result);
        return result;
    }

    function storedByMachinery(fnPath) {
        return flowsToStatic(fnPath) && createdByInitCode(fnPath);
    }

    // Follow a function value upwards to where it is stored. Accepted sinks: a static
    // binding, a member of a static binding (cache), or the return value of an IIFE /
    // machinery function that itself flows to such a sink. Anything handed to another
    // callee (callbacks, handler objects) is rejected: it may run at any time.
    function flowsToStatic(path) {
        let cur = path;
        for (;;) {
            const parent = cur.parentPath;
            if (!parent) return false;
            if (parent.isObjectProperty() && cur.key === 'value') { cur = parent.parentPath; continue; }
            if (parent.isObjectMethod() || (parent.isObjectExpression() && cur.isObjectMethod())) { cur = parent.isObjectExpression() ? parent : parent.parentPath; continue; }
            if (parent.isArrayExpression() || parent.isParenthesizedExpression() ||
                (parent.isConditionalExpression() && cur.key !== 'test') || parent.isLogicalExpression() ||
                (parent.isSequenceExpression() && cur.key === parent.node.expressions.length - 1)) { cur = parent; continue; }
            if (parent.isVariableDeclarator() && cur.key === 'init') {
                return bt.isIdentifier(parent.node.id) && staticSet.has(parent.scope.getBinding(parent.node.id.name));
            }
            if (parent.isAssignmentExpression() && cur.key === 'right') {
                let target = parent.node.left;
                while (bt.isMemberExpression(target)) target = target.object;
                return bt.isIdentifier(target) && staticSet.has(parent.scope.getBinding(target.name));
            }
            if (parent.isReturnStatement() || (parent.isArrowFunctionExpression() && cur.key === 'body')) {
                const fn = parent.isReturnStatement() ? parent.getFunctionParent() : parent;
                if (!fn) return false;
                if (isIife(fn)) { cur = fn.parentPath; continue; }
                return isMachineryFunction(fn);
            }
            return false;
        }
    }

    // Created by machinery, or by synchronous initialization code: the outermost body
    // statement crossed before the enclosing deferred function (or the program) is static.
    function createdByInitCode(fnPath) {
        let unit = null;
        for (let prev = fnPath, cur = fnPath.parentPath; cur; prev = cur, cur = cur.parentPath) {
            if (isDeferredBody(cur, prev)) {
                if (isMachineryFunction(cur)) return true;
                break;
            }
            if (isBodyStatement(cur)) unit = cur;
        }
        return !!unit && isStaticNode(unit.node);
    }

    // Does `path` (a write to / use of `binding`) only execute as part of machinery?
    // Code inside a non-IIFE function runs whenever that function is called, so it counts
    // only if that function is machinery; otherwise it must be synchronous initialization
    // code of a static body statement in the binding's own scope.
    function insideMachinery(path, binding) {
        const block = binding.scope.block;
        for (let prev = path, cur = path.parentPath; cur; prev = cur, cur = cur.parentPath) {
            if (cur.node === block) break;
            if (isDeferredBody(cur, prev)) return isMachineryFunction(cur);
        }
        const unit = unitOf.get(path);
        return !!unit && isStaticNode(unit.node);
    }

    const reasons = new Map();
    const explainInside = (path, binding) => {
        const block = binding.scope.block;
        for (let prev = path, cur = path.parentPath; cur; prev = cur, cur = cur.parentPath) {
            if (cur.node === block) break;
            if (isDeferredBody(cur, prev)) {
                const bound = bindingOfFn.get(cur.node);
                if (!bound) return 'in unbound fn@' + cur.node.loc?.start.line + (isStaticNode(cur.node) ? ' (not stored by machinery)' : ' using ' + (firstNonStatic(cur.node)?.identifier.name + '@' + firstNonStatic(cur.node)?.identifier.loc?.start.line));
                if (!staticSet.has(bound)) return 'in fn ' + bound.identifier.name + ' (non-static)';
                const d = firstNonStatic(cur.node);
                return 'in fn ' + bound.identifier.name + ' using ' + (d && d.identifier.name + '@' + d.identifier.loc?.start.line);
            }
        }
        const unit = unitOf.get(path);
        if (!unit) return 'no unit';
        const d = firstNonStatic(unit.node);
        return 'unit@' + unit.node.loc?.start.line + ' uses ' + (d && d.identifier.name + '@' + d.identifier.loc?.start.line + '[' + d.kind + ']');
    };
    const firstNonStatic = (node) => { for (const b of freeOf(node)) if (!staticSet.has(b)) return b; return null; };
    const why = (binding, msg) => { reasons.set(binding, msg); return false; };
    // Bindings kept static only because their payload writes sit inside value expressions
    // that are expected to be inlined: binding -> Set<expression node>.
    const provisional = new Map();
    const memoWrites = new Set();
    const allowProvisionally = (path, binding) => {
        const expr = consumerExpressionOf(path);
        if (!expr) return false;
        let set = provisional.get(binding);
        if (!set) provisional.set(binding, (set = new Set()));
        set.add(expr.node);
        return true;
    };

    // Inside the value being memoized by `C[k] = <value>` into a static object: that code
    // computes a decoded value (an inlined decoder copy), wherever it sits.
    function insideMemoValue(path) {
        for (let prev = path, cur = path.parentPath; cur; prev = cur, cur = cur.parentPath) {
            if (isDeferredBody(cur, prev)) return false;
            if (cur.isAssignmentExpression({ operator: '=' }) && prev.key === 'right' &&
                bt.isMemberExpression(cur.node.left) && cur.node.left.computed) {
                let root = cur.node.left.object;
                while (bt.isMemberExpression(root)) root = root.object;
                if (bt.isIdentifier(root) && staticSet.has(cur.scope.getBinding(root.name))) return true;
            }
        }
        return false;
    }
    const decodingContext = (path, binding) =>
        insideMachinery(path, binding) || insideMemoValue(path) || allowProvisionally(path, binding);

    // The expression a decoding write sits in: the value slot holding an inlined decoder
    // copy, or the `C[k] = <value>` memoization of a decoded value into a static object.
    function decodingExpressionOf(path) {
        const consumer = consumerExpressionOf(path);
        if (consumer) return consumer;
        for (let prev = path, cur = path.parentPath; cur; prev = cur, cur = cur.parentPath) {
            if (isDeferredBody(cur, prev)) return null;
            if (cur.isAssignmentExpression({ operator: '=' }) && bt.isMemberExpression(cur.node.left) && cur.node.left.computed) {
                let root = cur.node.left.object;
                while (bt.isMemberExpression(root)) root = root.object;
                if (bt.isIdentifier(root) && staticSet.has(cur.scope.getBinding(root.name))) return cur;
            }
        }
        return null;
    }

    // Bindings an expression reads or writes that are declared outside it.
    const freeCache = new Map();
    function freeBindingsOf(path) {
        let out = freeCache.get(path.node);
        if (out) return out;
        out = new Set();
        const visit = (p) => {
            if (!p.isReferencedIdentifier() && !p.isBindingIdentifier()) return;
            const b = p.scope.getBinding(p.node.name);
            if (b && b.path !== path && !b.path.isDescendant(path)) out.add(b);
        };
        if (path.isIdentifier()) visit(path);
        path.traverse({ Identifier: visit });
        freeCache.set(path.node, out);
        return out;
    }

    function stillStatic(binding) {
        if (forced.has(binding.identifier)) return why(binding, 'forced');
        provisional.delete(binding);
        const p = binding.path;
        if (binding.kind === 'param' && !isMachineryFunction(binding.scope.path)) return why(binding, 'param of non-machinery fn');
        if ((p.isVariableDeclarator() || p.isFunctionDeclaration()) && !isStaticNode(p.node)) {
            const d = firstNonStatic(p.node);
            return why(binding, 'decl uses ' + d.identifier.name + '@' + d.identifier.loc?.start.line);
        }
        for (const w of binding.constantViolations) {
            if (!decodingContext(w, binding)) {
                return why(binding, 'write@' + w.node.loc?.start.line + ' ' + explainInside(w, binding));
            }
        }
        for (const ref of binding.referencePaths) {
            const kind = referenceKind(ref);
            if (kind === 'read') continue;
            if (kind === 'call' && hasFixedArgs(ref.parentPath, binding)) continue;
            if (kind === 'alias') {
                const alias = ref.parentPath.scope.getBinding(ref.parentPath.node.id.name);
                if (alias && staticSet.has(alias)) continue;
            }
            // `C[k] = v` into a static object from elsewhere: memoization of a decoded value
            // (application code has no other reason to write into machinery objects).
            // An inlined decoder copy doing the write is evaluated as a whole when it fills a
            // value slot, like any other provisional write.
            if (isMemoWrite(ref)) {
                memoWrites.add(binding);
                allowProvisionally(ref, binding);
                continue;
            }
            if (!decodingContext(ref, binding)) {
                return why(binding, kind + '-ref@' + ref.node.loc?.start.line + ' ' + explainInside(ref, binding));
            }
        }
        return true;
    }

    // Greatest fixpoint: start optimistic, drop bindings until every condition holds.
    for (let changed = true; changed;) {
        changed = false;
        machineryMemo.clear();
        for (const b of staticSet) {
            if (!stillStatic(b)) {
                staticSet.delete(b);
                changed = true;
            }
        }
    }

    // ------------------------------------------------------------------------
    // Dependencies and units
    // ------------------------------------------------------------------------

    // Statements of a binding's own scope needed to reproduce its value: its declaration,
    // and the synchronous statements that write or mutate it.
    const unitsOf = new Map();
    const depsOf = new Map();          // everything needed to reproduce the value
    const structuralDepsOf = new Map(); // machinery only (excludes uses of decoded values)
    for (const b of staticSet) {
        const units = new Set();
        const deps = new Set();
        const sdeps = new Set();
        const declUnit = b.path.isFunctionDeclaration() ? b.path : b.path.parentPath;
        units.add(declUnit);
        for (const d of freeOf(b.path.node)) deps.add(d);
        for (const d of structuralOf(b.path.node)) sdeps.add(d);
        // Writes, plus every use that needs the machinery itself rather than a decoded value:
        // e.g. a rotator that calls the string array function with no arguments and shuffles
        // the array it returns. Calls to no-ops change nothing.
        const uses = [...b.constantViolations, ...b.referencePaths.filter(r =>
            !isValueUse(r) && !(referenceKind(r) === 'call' && isNoop(b)))];
        for (const u of uses) {
            let viaFn = null;
            for (let prev = u, cur = u.parentPath; cur && cur.node !== b.scope.block; prev = cur, cur = cur.parentPath) {
                if (isDeferredBody(cur, prev)) { viaFn = cur; break; }
            }
            if (viaFn) {
                const owner = bindingOfFn.get(viaFn.node);
                if (owner) deps.add(owner), sdeps.add(owner);
                continue;
            }
            const unit = unitOf.get(u);
            if (!unit || unit === declUnit) continue;
            if (isStaticNode(unit.node)) {
                units.add(unit);
                for (const d of freeOf(unit.node)) deps.add(d);
                for (const d of structuralOf(unit.node)) sdeps.add(d);
            } else {
                // A decoding expression inside application code (an inlined decoder copy or
                // a memoized value): only that expression is reproduced, not the statement
                // around it, so the application bindings next to it are not needed.
                const expr = decodingExpressionOf(u);
                if (expr) for (const d of freeBindingsOf(expr)) deps.add(d), sdeps.add(d);
            }
        }
        deps.delete(b);
        sdeps.delete(b);
        unitsOf.set(b, units);
        depsOf.set(b, deps);
        structuralDepsOf.set(b, sdeps);
    }

    const closureOf = (roots, graph = depsOf) => {
        const out = new Set();
        const stack = [...roots];
        while (stack.length) {
            const b = stack.pop();
            if (out.has(b) || !staticSet.has(b)) continue;
            out.add(b);
            for (const d of graph.get(b) || EMPTY) stack.push(d);
        }
        return out;
    };

    // Follow `const x = y` aliases to the binding that actually holds the value.
    const resolveAlias = (binding) => {
        const seen = new Set();
        while (binding && !seen.has(binding) && staticSet.has(binding) && binding.path.isVariableDeclarator() &&
            bt.isIdentifier(binding.path.node.init) && binding.constantViolations.length === 0) {
            seen.add(binding);
            const next = binding.path.scope.getBinding(binding.path.node.init.name);
            if (!next) break;
            binding = next;
        }
        return binding;
    };

    // ------------------------------------------------------------------------
    // Decoders and stores
    // ------------------------------------------------------------------------

    // String data: arrays of string literals — or of decoder calls, since an outer layer
    // may have encoded an inner layer's data. Decoders and string data are found together.
    const unitArrays = new Map(); // unit node -> { literal: bool, callees: Set<Binding> }
    const arraysOf = (unit) => {
        let info = unitArrays.get(unit.node);
        if (info) return info;
        info = { literal: false, callees: new Set() };
        const visit = (p) => {
            for (const el of p.get('elements')) {
                if (el.isStringLiteral()) info.literal = true;
                else if (el.isCallExpression() && el.get('callee').isIdentifier()) {
                    const target = resolveAlias(el.scope.getBinding(el.node.callee.name));
                    if (target) info.callees.add(target);
                }
            }
        };
        if (unit.isArrayExpression()) visit(unit);
        unit.traverse({ ArrayExpression: visit });
        unitArrays.set(unit.node, info);
        return info;
    };
    const dataUnitsOf = (b) => [...unitsOf.get(b)].map(u =>
        (u.isFunctionDeclaration() || u.isVariableDeclaration()) ? b.path : u);

    const functionBindings = [...staticSet].filter(b => {
        const fn = b.path.isFunctionDeclaration() ? b.path.node
            : b.path.isVariableDeclarator() && bt.isFunction(b.path.node.init) ? b.path.node.init : null;
        return fn && fn.params.length > 0;
    });
    const stringData = new Set();
    const decoders = new Set();
    for (let changed = true; changed;) {
        changed = false;
        for (const b of staticSet) {
            if (stringData.has(b)) continue;
            if (dataUnitsOf(b).some(u => {
                const info = arraysOf(u);
                return info.literal || [...info.callees].some(c => decoders.has(c));
            })) {
                stringData.add(b);
                changed = true;
            }
        }
        for (const b of functionBindings) {
            if (decoders.has(b)) continue;
            const closure = closureOf([b], structuralDepsOf);
            if ([...closure].some(d => stringData.has(d))) {
                decoders.add(b);
                changed = true;
            }
        }
    }

    // Machinery bindings: everything decoders need, including constant arrays they read.
    const machinery = closureOf(decoders);

    // Stores: static bindings read with literal keys that are decoder machinery, or that are
    // filled by a statement which itself defines a decoder (a string table such as
    // `$ = [h(94), ...]` built by its own IIFE). Application arrays that merely hold
    // decoded strings do not qualify.
    const decoderPaths = [...decoders].map(d => d.path);
    const stores = new Set();
    for (const b of staticSet) {
        if (b.path.isFunctionDeclaration()) continue;
        const hasLiteralRead = b.referencePaths.some(r => {
            const parent = r.parentPath;
            return referenceKind(r) === 'read' && parent.isMemberExpression() && parent.node.computed &&
                isLiteralValue(parent.node.property);
        });
        if (!hasLiteralRead) continue;
        if (machinery.has(b) ||
            [...unitsOf.get(b)].some(u => decoderPaths.some(d => d.isDescendant(u)))) {
            stores.add(b);
        }
    }

    const needed = closureOf([...decoders, ...stores]);

    // ------------------------------------------------------------------------
    // Live layers
    // ------------------------------------------------------------------------

    // A layer is live when its machinery is used structurally (not as a decoded value, and
    // not as a no-op call) from inside a function that is neither machinery nor run in
    // place: a handler or callback that runs at an unknown later time. The scope is
    // recorded so statements holding it are not run during observation (lib/unmangle.js).
    // Reads of and aliases to a binding whose member state is written at run time count
    // too: their contents are not reproduced state.
    const memberWrites = new Set();
    for (const b of needed) {
        if ([...b.referencePaths, ...b.constantViolations].some(isMemberWrite)) memberWrites.add(b);
    }
    const liveScopes = new Map(); // scope block node -> Set<Binding> used from callbacks
    for (const b of needed) {
        const writes = new Set(b.constantViolations);
        for (const ref of [...b.referencePaths, ...b.constantViolations]) {
            if (!writes.has(ref) && isValueUse(ref)) {
                const kind = referenceKind(ref);
                if (!memberWrites.has(b) || (kind !== 'alias' && kind !== 'read')) continue;
            }
            if (!writes.has(ref) && referenceKind(ref) === 'call' && isNoop(b)) continue;
            // The outermost function decides: code inside machinery runs only while decoding,
            // even when the machinery itself wraps it in a function.
            let outer = null;
            for (let prev = ref, cur = ref.parentPath; cur && cur.node !== b.scope.block; prev = cur, cur = cur.parentPath) {
                if (isDeferredBody(cur, prev)) outer = cur;
            }
            if (outer && !isMachineryFunction(outer)) {
                let set = liveScopes.get(b.scope.block);
                if (!set) liveScopes.set(b.scope.block, (set = new Set()));
                set.add(b);
            }
        }
    }

    return {
        programPath, bindings, staticSet, freeOf, structuralOf, reasons, provisional, memoWrites, unitsOf, depsOf, structuralDepsOf,
        decoders, stores, needed, machinery, resolveAlias, liveScopes, isStaticNode, isNoop, freeBindingsOf,
    };
}

const EMPTY = new Set();

module.exports = { analyze, referenceKind, isLiteralValue, isFixedArgShape, isBodyStatement, isIife, isDeferredBody, isValueSlot, isStandalone };
