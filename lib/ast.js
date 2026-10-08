/**
 * Small AST helpers shared by the deobfuscation phases.
 */
const bt = require('@babel/types');

// (function () {...})(), (() => {...})(), !function () {...}(), (function () {...}).call(this)
function iifeFunction(path) {
    if (path.isUnaryExpression()) path = path.get('argument');
    if (!path.isCallExpression()) return null;
    let callee = path.get('callee');
    if (callee.isMemberExpression() && !callee.node.computed &&
        bt.isIdentifier(callee.node.property) &&
        (callee.node.property.name === 'call' || callee.node.property.name === 'apply')) {
        callee = callee.get('object');
    }
    return callee.isFunctionExpression() || callee.isArrowFunctionExpression() ? callee : null;
}

// Bundles are wrapped in IIFEs; descend through single-statement wrappers to the statement
// list that holds the program's own top level.
function findTopLevel(programPath) {
    let stmts = programPath.get('body');
    while (stmts.length === 1 && stmts[0].isExpressionStatement()) {
        const fn = iifeFunction(stmts[0].get('expression'));
        if (!fn || !fn.get('body').isBlockStatement()) break;
        stmts = fn.get('body.body');
    }
    return stmts;
}

// Loop heads and catch clauses: bindings that take a new value per iteration or error.
function isLoopOrCatchBinding(binding) {
    const p = binding.path;
    if (p.isCatchClause() || (p.parentPath && p.parentPath.isCatchClause())) return true;
    if (!p.isVariableDeclarator()) return false;
    const decl = p.parentPath;
    const loop = decl.parentPath;
    return (loop.isForStatement() && loop.node.init === decl.node) ||
        ((loop.isForInStatement() || loop.isForOfStatement()) && loop.node.left === decl.node);
}

module.exports = { iifeFunction, findTopLevel, isLoopOrCatchBinding };
