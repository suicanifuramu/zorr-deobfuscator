/**
 * Zorr Deobfuscator v4 — importable module.
 *
 * deobfuscate(webcrackedCode: string) → { code, stats }
 *
 * Nothing depends on identifier names, string contents or code positions. The obfuscator's
 * machinery is found by data-flow analysis (lib/analysis.js), reproduced and evaluated in an
 * isolated-vm sandbox, and its results are inlined layer by layer until nothing changes
 * (lib/layers.js). Member renames are undone by observing the code that defines them
 * (lib/unmangle.js). Layers operated from callbacks at run time are decoded too when every
 * runtime operation is reproducible; otherwise they are left as they are.
 * Throws when the input holds no obfuscator machinery at all.
 */
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const bt = require('@babel/types');
const { createSandbox } = require('./lib/sandbox');
const { peelLayers } = require('./lib/layers');
const { simplify } = require('./lib/simplify');
const { unmangle } = require('./lib/unmangle');
const { removeDeadMachinery } = require('./lib/cleanup');

function deobfuscate(sourceCode, { log = (...args) => console.log(...args) } = {}) {
    log('=== Zorr Deobfuscator v4 ===');
    const sandbox = createSandbox();
    try {
        return deobfuscateWith(sandbox, sourceCode, log);
    } finally {
        sandbox.dispose();
    }
}

function deobfuscateWith(sandbox, sourceCode, log) {
    log('Phase 1: Parsing source...');
    const ast = parser.parse(sourceCode, { sourceType: 'script' });

    log('Phase 2: Peeling obfuscation layers...');
    const peel = peelLayers(ast, sandbox, { log });
    if (!peel.machinery.size) {
        throw new Error('No obfuscator machinery found in source (no string array decoders or constant tables).');
    }
    const shared = { forced: peel.forced, frozen: peel.frozen };

    log('Phase 3: Simplifying decoded expressions...');
    const simplified = simplify(ast, sandbox, shared);
    log(`  Folded ${simplified.concatenations} string concatenations and ${simplified.foldedCalls} closed calls; ` +
        `unwrapped ${simplified.noopCalls} no-op and ${simplified.identityCalls} identity calls.`);

    log('Phase 4: Undoing member renames by observing their definitions...');
    const unmangled = unmangle(ast, sandbox, { ...shared, liveScopes: peel.liveScopes, source: sourceCode, log });
    log(`  ${unmangled.mappings} member aliases; renamed ${unmangled.renamed} occurrences` +
        (unmangled.conflicts.length ? `; left ambiguous: ${unmangled.conflicts.join(', ')}` : '') + '.');

    log('Phase 5: Removing unused machinery...');
    const removed = removeDeadMachinery(ast, { ...shared, machinery: peel.machinery });
    log(`  Removed ${removed.statements} statements (${removed.bindings} bindings).`);

    log('Phase 6: Normalizing member access...');
    const normalized = normalizeAccess(ast);
    log(`  Normalized ${normalized.members} x["y"] → x.y and ${normalized.keys} ["y"]: → y: keys.`);

    const code = generate(ast, { retainLines: false, compact: false }).code;
    const stats = {
        size: code.length,
        lines: code.split('\n').length,
        rounds: peel.stats.rounds,
        decoderCalls: peel.stats.calls,
        tableLookups: peel.stats.lookups,
        inlinedCopies: peel.stats.expressions,
        liveLayers: peel.stats.liveLayers,
        decodedLiveLayers: peel.stats.decodedLiveLayers,
        ...simplified,
        memberAliases: unmangled.mappings,
        memberRenames: unmangled.renamed,
        removedStatements: removed.statements + unmangled.removed,
    };
    log('\n=== Complete ===');
    log('Size:', stats.size, 'bytes');
    log('Lines:', stats.lines);
    log('Live layers left as is:', stats.liveLayers.length ? stats.liveLayers.join(', ') : 'none');
    if (stats.decodedLiveLayers.length) log('Live layers decoded from callbacks:', stats.decodedLiveLayers.join(', '));
    return { code, stats };
}

// x["y"] → x.y and computed literal keys (objects and class members) → plain names.
// String literal contents are never touched.
function normalizeAccess(ast) {
    const counts = { members: 0, keys: 0 };
    const memberVisitor = (path) => {
        const node = path.node;
        if (!node.computed || !bt.isStringLiteral(node.property) || !bt.isValidIdentifier(node.property.value, false)) return;
        node.property = bt.identifier(node.property.value);
        node.computed = false;
        counts.members++;
    };
    const keyVisitor = (path) => {
        const node = path.node;
        if (!node.computed || !bt.isStringLiteral(node.key)) return;
        const name = node.key.value;
        // { ["__proto__"]: x } defines an own property, { __proto__: x } sets the prototype.
        if (name === '__proto__' || !bt.isValidIdentifier(name, false)) return;
        // Class members: ["constructor"] is a regular method, constructor is the constructor;
        // a static member named prototype throws at run time as ["prototype"] and is a
        // parse error as prototype. Leave these computed.
        if ((path.isClassMethod() || path.isClassProperty() || path.isClassAccessorProperty()) &&
            (name === 'constructor' || name === 'prototype')) return;
        node.key = bt.identifier(name);
        node.computed = false;
        counts.keys++;
    };
    traverse(ast, {
        MemberExpression: memberVisitor,
        OptionalMemberExpression: memberVisitor,
        ObjectProperty: keyVisitor,
        ObjectMethod: keyVisitor,
        ClassMethod: keyVisitor,
        ClassProperty: keyVisitor,
        ClassAccessorProperty: keyVisitor,
    });
    return counts;
}

module.exports = { deobfuscate };
