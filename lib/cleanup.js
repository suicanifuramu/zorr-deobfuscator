/**
 * Removal of decoder machinery nothing refers to any more. Once its uses are inlined, the
 * string arrays, decoders, rotators, caches, no-op helpers and aliases of a layer are only
 * referenced by each other; they are removed together, and only when no other code refers
 * to any of them. Frozen blocks (live layers) are never touched, so machinery they still use
 * stays in place.
 */
const bt = require('@babel/types');
const { analyze, isIife } = require('./analysis');
const { isInside } = require('./layers');

function removeDeadMachinery(ast, { forced = new Set(), frozen = new Set(), machinery = new Set() } = {}) {
    const r = analyze(ast, { forced });
    const outside = (path) => !isInside(path, frozen);

    const aliasOfMachinery = (b) => b.path.isVariableDeclarator() && bt.isIdentifier(b.path.node.init) &&
        !b.constantViolations.length && machinery.has(r.resolveAlias(b).identifier);
    const removable = new Set(r.bindings.filter(b =>
        b.kind !== 'param' && r.staticSet.has(b) && outside(b.path) &&
        (machinery.has(b.identifier) || r.isNoop(b) || aliasOfMachinery(b))));

    // A statement can go when everything it declares or writes goes too and it touches no
    // global state of its own.
    const deletable = (unit) => {
        if (!r.isStaticNode(unit.node) || !outside(unit)) return false;
        const scope = unit.parentPath.scope;
        const declared = unit.isFunctionDeclaration() ? [unit.node.id.name]
            : unit.isVariableDeclaration() ? Object.keys(unit.getBindingIdentifiers()) : [];
        if (declared.some(name => !removable.has(scope.getBinding(name)))) return false;
        // Only what runs when the statement itself runs: function bodies run when called,
        // and nothing calls these any more.
        if (unit.isFunctionDeclaration()) return true;
        let ok = true;
        const inside = (b) => b.path === unit || b.path.isDescendant(unit);
        unit.traverse({
            Function(p) {
                if (!isIife(p)) p.skip();
            },
            'AssignmentExpression|UpdateExpression'(p) {
                let target = p.isAssignmentExpression() ? p.node.left : p.node.argument;
                while (bt.isMemberExpression(target)) target = target.object;
                if (!bt.isIdentifier(target)) return;
                const b = p.scope.getBinding(target.name);
                if (!b || (!inside(b) && !removable.has(b))) {
                    ok = false;
                    p.stop();
                }
            },
        });
        return ok;
    };

    let units;
    for (;;) {
        units = new Map(); // node -> path
        const blocked = new Set();
        for (const b of removable) {
            for (const u of r.unitsOf.get(b) || []) {
                if (deletable(u)) units.set(u.node, u);
                else blocked.add(b);
            }
        }
        const gone = (path) => units.has(path.node) || !!path.findParent(p => units.has(p.node));
        const live = [...removable].filter(b => blocked.has(b) ||
            [...b.referencePaths, ...b.constantViolations].some(ref => !gone(ref)));
        if (!live.length) break;
        for (const b of live) removable.delete(b);
    }

    let removed = 0;
    for (const u of units.values()) {
        if (u.findParent(p => units.has(p.node))) continue;
        u.remove();
        removed++;
    }
    return { bindings: removable.size, statements: removed };
}

module.exports = { removeDeadMachinery };
