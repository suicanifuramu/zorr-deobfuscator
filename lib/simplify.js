/**
 * Clean-up of what the obfuscator leaves around decoded values. Nothing here relies on
 * names: every rule follows from the shape of the code or from evaluating it.
 *
 *   - "a" + "b"                        → "ab"
 *   - closed functions called in place with literal arguments (operator functions such as
 *     function (n, t, e) { if (n === "x") return t + e; }("x", 1, 4))  → their result
 *   - calls to no-ops (function F() { F = function () {}; }) used to group expressions
 *     F(a = 1, b())                    → a = 1; b();
 *   - calls to identity functions      f(x) → x
 *
 * Code inside frozen blocks (live layers) is left untouched.
 */
const generate = require('@babel/generator').default;
const bt = require('@babel/types');
const { analyze, isLiteralValue } = require('./analysis');
const { isInside } = require('./layers');
const { run } = require('./sandbox');

function simplify(ast, sandbox, { forced = new Set(), frozen = new Set() } = {}) {
    const stats = { concatenations: 0, foldedCalls: 0, noopCalls: 0, identityCalls: 0 };
    const r = analyze(ast, { forced });
    const programPath = r.programPath;
    const outside = (p) => !isInside(p, frozen);

    // "a" + "b"
    programPath.traverse({
        BinaryExpression: {
            exit(p) {
                const { operator, left, right } = p.node;
                if (operator !== '+' || !bt.isStringLiteral(left) || !bt.isStringLiteral(right) || !outside(p)) return;
                p.replaceWith(bt.stringLiteral(left.value + right.value));
                stats.concatenations++;
            },
        },
    });

    // Closed functions called in place with literal arguments: deterministic, so their
    // result can be computed. "Closed" means every name inside is declared inside, apart
    // from the realm's constant globals (undefined, NaN, Infinity).
    const folds = [];
    const freeNames = new Set();
    programPath.traverse({
        CallExpression(p) {
            const callee = p.get('callee');
            if (!callee.isFunctionExpression() && !callee.isArrowFunctionExpression()) return;
            if (!p.node.arguments.every(isLiteralValue) || !outside(p)) return;
            const names = closedOver(callee);
            if (!names) return;
            for (const n of names) freeNames.add(n);
            folds.push({ path: p, names });
        },
    });
    if (folds.length) {
        const ctx = sandbox.context();
        try {
            const constants = new Set(JSON.parse(run(ctx, `JSON.stringify(${JSON.stringify([...freeNames])}.filter(n => {
                const d = Object.getOwnPropertyDescriptor(globalThis, n);
                return d && 'value' in d && !d.writable && !d.configurable;
            }))`)));
            const ready = folds.filter(f => [...f.names].every(n => constants.has(n)));
            const results = JSON.parse(run(ctx, `JSON.stringify([${ready.map(f =>
                `(() => { try { return __encode((${generate(f.path.node).code})); } catch (e) { return null; } })()`).join(',\n')}])`));
            ready.forEach((f, i) => {
                const node = literal(results[i]);
                if (!node) return;
                f.path.replaceWith(node);
                stats.foldedCalls++;
            });
        } finally {
            ctx.release();
        }
    }

    // No-op and identity calls. Bindings come from the analysis: only static functions (never
    // reassigned from outside) qualify.
    const noops = new Set([...r.staticSet].filter(b => r.isNoop(b)));
    const identities = new Set([...r.staticSet].filter(isIdentity));
    programPath.traverse({
        CallExpression(p) {
            const callee = p.node.callee;
            if (!bt.isIdentifier(callee) || !outside(p)) return;
            const b = p.scope.getBinding(callee.name);
            if (!b) return;
            if (noops.has(b) && p.parentPath.isExpressionStatement()) {
                const effects = p.node.arguments.filter(a => !isPure(a));
                p.parentPath.replaceWithMultiple(effects.map(a => bt.expressionStatement(a)));
                stats.noopCalls++;
            } else if (identities.has(b) && p.node.arguments.length >= 1 && p.node.arguments.slice(1).every(isPure)) {
                p.replaceWith(p.node.arguments[0]);
                stats.identityCalls++;
            }
        },
    });
    return stats;
}

// Names a function refers to without declaring them, or null if it uses `this`/`arguments`.
function closedOver(fnPath) {
    const names = new Set();
    let ok = true;
    fnPath.traverse({
        ThisExpression(p) { if (p.getFunctionParent() === fnPath || fnPath.isArrowFunctionExpression()) ok = false; },
        ReferencedIdentifier(p) {
            const b = p.scope.getBinding(p.node.name);
            if (!b) {
                if (p.node.name === 'arguments') ok = false;
                names.add(p.node.name);
            } else if (b.path !== fnPath && !b.path.isDescendant(fnPath)) {
                ok = false;
            }
        },
        // Writes to outer bindings make the call impure.
        'AssignmentExpression|UpdateExpression'(p) {
            const ids = Object.keys(p.getBindingIdentifiers());
            for (const name of ids) {
                const b = p.scope.getBinding(name);
                if (!b || (b.path !== fnPath && !b.path.isDescendant(fnPath))) ok = false;
            }
        },
    });
    return ok ? names : null;
}

// function f(x) { return x; }
function isIdentity(binding) {
    const p = binding.path;
    if (!p.isFunctionDeclaration() || binding.constantViolations.length) return false;
    const { params, body } = p.node;
    return params.length >= 1 && bt.isIdentifier(params[0]) && body.body.length === 1 &&
        bt.isReturnStatement(body.body[0]) && bt.isIdentifier(body.body[0].argument, { name: params[0].name });
}

function isPure(node) {
    return isLiteralValue(node) || bt.isIdentifier(node, { name: 'undefined' });
}

function literal(encoded) {
    if (!encoded) return null;
    const [tag, v] = encoded;
    switch (tag) {
        case 's': return bt.stringLiteral(v);
        case 'b': return bt.booleanLiteral(v);
        case 'l': return bt.nullLiteral();
        case 'n': {
            const n = Number(v);
            if (v === '-0' || !Number.isFinite(n)) return null;
            return n < 0 ? bt.unaryExpression('-', bt.numericLiteral(-n)) : bt.numericLiteral(n);
        }
        default: return null;
    }
}

module.exports = { simplify };
