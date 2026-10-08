/**
 * Zorr Deobfuscator v3 — importable module.
 *
 * deobfuscate(webcrackedCode: string) → { code, stats }
 * Locates the obfuscator's own decoders structurally (no hardcoded identifier names or
 * line numbers), runs them inside an isolated-vm sandbox and inlines the results.
 * Throws on unrecoverable structure mismatches instead of exiting the process.
 */
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const bt = require('@babel/types');

let ivm;
try {
    ivm = require('isolated-vm');
} catch (err) {
    throw new Error(
        'isolated-vm could not be loaded. Allow its native build (pnpm-workspace.yaml: ' +
        'allowBuilds.isolated-vm: true) and reinstall. Cause: ' + err.message
    );
}

// The decoders come from the remote site, so they run in a separate V8 isolate: no access
// to require/process/fs, bounded memory, and a timeout for loops that never converge.
const VM_TIMEOUT_MS = 10000;
const VM_MEMORY_MB = 512;

// isolated-vm contexts are bare ECMAScript, so browser helpers the decoders call are
// provided as plain JS inside the sandbox rather than passed in from the host.
const BASE64_SHIM = `
(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    globalThis.atob = function (input) {
        const str = String(input).replace(/[\\t\\n\\f\\r =]+/g, '');
        let out = '', buffer = 0, bits = 0;
        for (let i = 0; i < str.length; i++) {
            const v = chars.indexOf(str[i]);
            if (v < 0) throw new Error('atob: invalid character');
            buffer = (buffer << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((buffer >> bits) & 0xff);
                buffer &= (1 << bits) - 1;
            }
        }
        return out;
    };
    globalThis.btoa = function (input) {
        const str = String(input);
        let out = '';
        for (let i = 0; i < str.length; i += 3) {
            const a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
            if (a > 255 || b > 255 || c > 255) throw new Error('btoa: invalid character');
            const n = (a << 16) | ((b || 0) << 8) | (c || 0);
            out += chars[n >> 18] + chars[(n >> 12) & 63] +
                (i + 1 < str.length ? chars[(n >> 6) & 63] : '=') +
                (i + 2 < str.length ? chars[n & 63] : '=');
        }
        return out;
    };
})();
`;

// Fake browser globals for the unmangler. Any unknown property yields another stub, so its
// window.CanvasRenderingContext2D.prototype (etc.) probing never throws, and JSON.parse is
// wrapped to record the tables it decodes.
const UNMANGLER_ENV = `
(() => {
    const tables = [];
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) {
        const value = parse(text, reviver);
        tables.push(value);
        return value;
    };
    globalThis.__tables = tables;
    const stub = () => {
        const store = Object.create(null);
        return new Proxy(function () {}, {
            get(target, key) {
                if (key === Symbol.toPrimitive) return () => '';
                if (key in store) return store[key];
                return (store[key] = key === 'prototype' ? {} : stub());
            },
            set(target, key, value) { store[key] = value; return true; },
            // Must also report the target's own non-configurable keys (prototype) to satisfy
            // the Proxy invariants.
            has(target, key) { return key in store || key in target; },
            apply: () => stub(),
            construct: () => stub(),
        });
    };
    const real = {
        Math, DataView, JSON, Object, String, Array, Number, Boolean, Uint8Array, Function,
        Symbol, Reflect, Proxy, Error, RegExp, Date, atob, btoa, parseInt, parseFloat,
    };
    const store = Object.create(null);
    globalThis.window = new Proxy(store, {
        get(target, key) {
            if (key in store) return store[key];
            return (store[key] = key in real ? real[key] : stub());
        },
        set(target, key, value) { store[key] = value; return true; },
    });
    globalThis.document = globalThis.window.document;
})();
`;

function createSandbox() {
    const isolate = new ivm.Isolate({ memoryLimit: VM_MEMORY_MB });
    return {
        // Each context starts from the shim plus the given setup code.
        context(...setup) {
            const context = isolate.createContextSync();
            for (const code of [BASE64_SHIM, ...setup]) run(context, code);
            return context;
        },
        dispose() {
            if (!isolate.isDisposed) isolate.dispose();
        },
    };
}

function run(context, code) {
    return context.evalSync(code, { timeout: VM_TIMEOUT_MS });
}

// ============================================================================
// AST helpers
// ============================================================================

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

function isIifeStatement(path) {
    return path.isExpressionStatement() && iifeFunction(path.get('expression')) !== null;
}

// webcrack leaves the bundle wrapped in IIFEs; descend through single-statement wrappers to
// the statement list that holds the decoder infrastructure.
function findTopLevel(programPath) {
    let scope = programPath.scope;
    let stmts = programPath.get('body');
    while (stmts.length === 1 && stmts[0].isExpressionStatement()) {
        const fn = iifeFunction(stmts[0].get('expression'));
        if (!fn || !fn.get('body').isBlockStatement()) break;
        scope = fn.scope;
        stmts = fn.get('body.body');
    }
    return { scope, stmts };
}

function referencesAny(path, bindings) {
    let found = false;
    path.traverse({
        ReferencedIdentifier(p) {
            if (bindings.has(p.scope.getBinding(p.node.name))) {
                found = true;
                p.stop();
            }
        },
    });
    return found;
}

function callsBinding(path, binding) {
    let found = false;
    path.traverse({
        CallExpression(p) {
            const callee = p.node.callee;
            if (bt.isIdentifier(callee) && p.scope.getBinding(callee.name) === binding) {
                found = true;
                p.stop();
            }
        },
    });
    return found;
}

function hasParseIntLoop(path) {
    let loop = false, parseIntCall = false;
    path.traverse({
        Loop() { loop = true; },
        CallExpression(p) {
            const callee = p.node.callee;
            // getBinding, not hasBinding: the latter also reports builtin globals like parseInt.
            if (bt.isIdentifier(callee, { name: 'parseInt' }) && !p.scope.getBinding('parseInt')) {
                parseIntCall = true;
            }
        },
    });
    return loop && parseIntCall;
}

// Literal call arguments as plain JS values, or null if any argument is dynamic.
function literalArgs(args) {
    const values = [];
    for (const arg of args) {
        if (bt.isNumericLiteral(arg) || bt.isStringLiteral(arg)) values.push(arg.value);
        else if (bt.isUnaryExpression(arg, { operator: '-' }) && bt.isNumericLiteral(arg.argument)) values.push(-arg.argument.value);
        else return null;
    }
    return values;
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

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ============================================================================
// Main
// ============================================================================

function deobfuscate(sourceCode) {
    console.log('=== Zorr Deobfuscator v3 ===');
    const sandbox = createSandbox();
    try {
        return deobfuscateWith(sandbox, sourceCode);
    } finally {
        sandbox.dispose();
    }
}

function deobfuscateWith(sandbox, sourceCode) {
    // ========================================================================
    // PHASE 1: Parse AST and locate the string array infrastructure
    // ========================================================================
    console.log('Phase 1: Parsing source and locating string array decoder...');
    const ast = parser.parse(sourceCode, { sourceType: 'script' });
    let programPath = null;
    traverse(ast, { Program(path) { programPath = path; path.stop(); } });
    const top = findTopLevel(programPath);

    // String array function: the top-level function declaration holding the largest array
    // literal made only of strings — function a() { const n = [...]; return (a = ...)(); }
    let arrayFn = null, arraySize = 0;
    for (const stmt of top.stmts) {
        if (!stmt.isFunctionDeclaration()) continue;
        stmt.traverse({
            ArrayExpression(p) {
                const els = p.node.elements;
                if (els.length > arraySize && els.every(el => bt.isStringLiteral(el))) {
                    arrayFn = stmt;
                    arraySize = els.length;
                }
            },
        });
    }
    if (!arrayFn) throw new Error('Could not find the string array function in source.');
    const arrayBinding = top.scope.getBinding(arrayFn.node.id.name);

    // Decoders: other top-level functions that call the array function — function b(n, t)
    const decoderFns = top.stmts.filter(s =>
        s.isFunctionDeclaration() && s !== arrayFn && callsBinding(s, arrayBinding));
    if (!decoderFns.length) throw new Error('Could not find a decoder function calling the string array.');
    const decoderBindings = decoderFns.map(s => top.scope.getBinding(s.node.id.name));

    // Rotator: the IIFE that shuffles the array until a parseInt checksum matches. Optional.
    // It must touch the array function itself — the unmangler also has a parseInt loop and
    // calls the decoder, but never the array function.
    const rotators = top.stmts.filter(s =>
        isIifeStatement(s) && referencesAny(s, new Set([arrayBinding])) && hasParseIntLoop(s));
    if (rotators.length > 1) console.log(`  Warning: ${rotators.length} rotator candidates; using the first.`);
    const rotator = rotators[0];

    console.log(`  String array: ${arrayFn.node.id.name}() with ${arraySize} strings (line ${arrayFn.node.loc.start.line})`);
    console.log(`  Decoder(s): ${decoderFns.map(s => `${s.node.id.name}() (line ${s.node.loc.start.line})`).join(', ')}`);
    console.log(rotator ? `  Rotator IIFE at line ${rotator.node.loc.start.line}` : '  No rotator IIFE found.');

    // Captured before any AST mutation: later phases need the original decoder code.
    const stringArraySetup = [arrayFn, rotator, ...decoderFns]
        .filter(Boolean)
        .map(p => generate(p.node).code)
        .join('\n');

    // ========================================================================
    // PHASE 2: Resolve decoder calls (scope-aware alias tracing)
    // ========================================================================
    console.log('Phase 2: Resolving string array decoder calls...');

    // Follow `const x = b`-style aliases through the scope graph, so only identifiers that
    // really refer to the decoder are resolved — unrelated locals with the same name are not.
    const calls = [];
    const seen = new Set(decoderBindings);
    const queue = decoderBindings.map(binding => ({ binding, root: binding.identifier.name }));
    let aliasCount = 0, dynamicCount = 0;
    while (queue.length) {
        const { binding, root } = queue.shift();
        for (const ref of binding.referencePaths) {
            const parent = ref.parentPath;
            if (parent.isCallExpression() && parent.node.callee === ref.node) {
                const args = literalArgs(parent.node.arguments);
                if (args) calls.push({ path: parent, key: JSON.stringify([root, ...args]) });
                else dynamicCount++;
            } else if (parent.isVariableDeclarator() && parent.node.init === ref.node && bt.isIdentifier(parent.node.id)) {
                const alias = parent.scope.getBinding(parent.node.id.name);
                if (alias && alias.constantViolations.length === 0 && !seen.has(alias)) {
                    seen.add(alias);
                    queue.push({ binding: alias, root });
                    aliasCount++;
                }
            }
        }
    }
    console.log(`  Traced ${aliasCount} alias bindings, ${calls.length} literal call sites.`);

    const keys = [...new Set(calls.map(c => c.key))];
    const decodeCtx = sandbox.context(stringArraySetup);
    // One batched round trip; each key is [decoderName, ...literalArgs].
    const decodedJson = run(decodeCtx, `JSON.stringify([${keys.join(',')}].map(([fn, ...args]) => {
        try {
            const v = globalThis[fn](...args);
            return typeof v === 'string' ? v : null;
        } catch (e) {
            return null;
        }
    }))`);
    decodeCtx.release();
    const decoded = new Map(JSON.parse(decodedJson).map((v, i) => [keys[i], v]));

    let decoderReplaced = 0, decoderFailed = 0;
    for (const { path, key } of calls) {
        const value = decoded.get(key);
        if (typeof value === 'string') {
            path.replaceWith(bt.stringLiteral(value));
            decoderReplaced++;
        } else {
            decoderFailed++;
        }
    }
    if (calls.length) {
        const sample = calls.find(c => typeof decoded.get(c.key) === 'string');
        if (sample) console.log(`  Sample: ${sample.key} = ${JSON.stringify(decoded.get(sample.key)).slice(0, 60)}`);
    }
    console.log(`  Decoder calls: ${decoderReplaced} replaced, ${decoderFailed} failed, ${dynamicCount} non-literal skipped`);

    // ========================================================================
    // PHASE 3: Resolve string tables — top-level `let $` filled by an IIFE `$ = [h(94), ...]`
    // ========================================================================
    console.log('Phase 3: Resolving string table lookups...');

    // Each table IIFE carries its own local decoder; running it whole avoids depending on
    // that decoder's name or layout. Only arrays built purely from decoder calls/strings
    // count, so an ordinary `x = [...]` in the main code never gets the main code executed.
    const isTableElement = el => bt.isCallExpression(el) || bt.isStringLiteral(el);
    const tables = [];
    for (const stmt of top.stmts) {
        if (!isIifeStatement(stmt) || stmt === rotator) continue;
        stmt.traverse({
            AssignmentExpression(p) {
                const { left, right } = p.node;
                if (p.node.operator !== '=' || !bt.isIdentifier(left) || !bt.isArrayExpression(right)) return;
                if (!right.elements.length || !right.elements.every(isTableElement)) return;
                const binding = p.scope.getBinding(left.name);
                if (binding && binding.scope === top.scope && !tables.some(t => t.binding === binding)) {
                    tables.push({ binding, iife: stmt });
                }
            },
        });
    }

    let tableReplaced = 0;
    for (const { binding, iife } of tables) {
        const name = binding.identifier.name;
        let values;
        try {
            const ctx = sandbox.context(stringArraySetup, `var ${name};`);
            run(ctx, generate(iife.node).code);
            values = JSON.parse(run(ctx, `JSON.stringify(${name})`) || 'null');
            ctx.release();
        } catch (err) {
            console.log(`  Warning: executing the ${name} table IIFE failed: ${err.message}`);
            continue;
        }
        if (!Array.isArray(values)) {
            console.log(`  Warning: ${name} is not an array after executing its IIFE.`);
            continue;
        }
        if (binding.constantViolations.length > 1) {
            console.log(`  Warning: ${name} is reassigned ${binding.constantViolations.length} times; using its first value.`);
        }
        console.log(`  ${name}: ${values.length} elements (filled by IIFE at line ${iife.node.loc.start.line})`);

        let replaced = 0;
        traverse(ast, {
            MemberExpression(path) {
                const { object, property, computed } = path.node;
                if (!computed || !bt.isIdentifier(object, { name }) || !bt.isNumericLiteral(property)) return;
                if (path.scope.getBinding(name) !== binding || isWriteTarget(path)) return;
                const value = values[property.value];
                if (typeof value === 'string') {
                    path.replaceWith(bt.stringLiteral(value));
                    replaced++;
                }
            },
        });
        console.log(`  Replaced ${replaced} ${name}[N] lookups.`);
        tableReplaced += replaced;
    }
    if (!tables.length) console.log('  Warning: no string table IIFE found.');

    // ========================================================================
    // PHASE 4: Remove .es() wrappers
    // ========================================================================
    let esRemovedCount = 0;
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (bt.isMemberExpression(callee) &&
                bt.isIdentifier(callee.property, { name: 'es' }) &&
                path.node.arguments.length === 1) {
                path.replaceWith(path.node.arguments[0]);
                esRemovedCount++;
            }
        },
        ObjectMethod(path) {
            if (path.node.key && bt.isIdentifier(path.node.key, { name: 'es' })) path.remove();
        },
        ClassMethod(path) {
            if (path.node.key && bt.isIdentifier(path.node.key, { name: 'es' })) path.remove();
        },
    });
    console.log(`Phase 4: .es() wrappers: ${esRemovedCount} removed`);

    // ========================================================================
    // PHASE 5: Capture the .$N member mangle tables from the runtime unmangler
    // ========================================================================
    // The obfuscator renames builtin members (Math.*, ctx.*, document.*, DataView.*) to $N
    // and embeds an IIFE that decodes the mapping via JSON.parse(atob(...)) and patches the
    // builtins at runtime. We run that IIFE against fake browser globals and record the tables.
    console.log('Phase 5: Capturing .$N mangle tables from runtime unmangler...');

    const isJsonOfAtob = (node) =>
        bt.isCallExpression(node) &&
        bt.isMemberExpression(node.callee) && bt.isIdentifier(node.callee.object, { name: 'JSON' }) &&
        node.arguments.length >= 1 && bt.isCallExpression(node.arguments[0]) &&
        bt.isIdentifier(node.arguments[0].callee, { name: 'atob' });

    let unmangler = null;
    for (const stmt of top.stmts) {
        if (!isIifeStatement(stmt)) continue;
        let count = 0;
        stmt.traverse({ CallExpression(p) { if (isJsonOfAtob(p.node)) count++; } });
        if (count >= 2 && (!unmangler || stmt.node.end - stmt.node.start < unmangler.node.end - unmangler.node.start)) {
            unmangler = stmt;
        }
    }

    const reverse = {};
    if (unmangler) {
        console.log(`  Unmangler IIFE at line ${unmangler.node.loc.start.line}`);
        const ctx = sandbox.context(UNMANGLER_ENV, stringArraySetup);
        try {
            run(ctx, generate(unmangler.node).code);
        } catch (err) {
            // Tables recorded before the failure are still usable.
            console.log('  Warning: unmangler threw:', err.message);
        }
        const recorded = JSON.parse(run(ctx, 'JSON.stringify(globalThis.__tables)'));
        ctx.release();
        // Keep only tables whose values all look like $N mangles.
        for (const table of recorded) {
            if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
            const vals = Object.values(table);
            if (vals.length && vals.every(v => typeof v === 'string' && /^\$\d+$/.test(v))) {
                for (const [k, v] of Object.entries(table)) reverse[v] = k;
            }
        }
        console.log(`  Extracted ${Object.keys(reverse).length} mappings from ${recorded.length} runtime tables.`);
    } else {
        console.log('  Warning: unmangler IIFE not found in source.');
    }

    // ========================================================================
    // PHASE 6: Rename .$N members and normalize bracket access (on the AST, so string
    // literal contents are never touched)
    // ========================================================================
    console.log('Phase 6: Renaming .$N members and normalizing bracket access...');

    const MANGLED = /^\$\d+$/;
    const seenMangled = new Set();
    const unresolved = new Set();
    let renamedCount = 0, dotCount = 0, keyCount = 0;

    const memberVisitor = (path) => {
        const node = path.node;
        if (node.computed && bt.isStringLiteral(node.property)) {
            const name = node.property.value;
            if (MANGLED.test(name)) seenMangled.add(name);
            const real = MANGLED.test(name) && hasOwn(reverse, name) ? reverse[name] : name;
            if (real !== name) renamedCount++;
            if (bt.isValidIdentifier(real, false)) {
                node.property = bt.identifier(real);
                node.computed = false;
                dotCount++;
            } else if (real !== name) {
                node.property = bt.stringLiteral(real);
            }
        } else if (!node.computed && bt.isIdentifier(node.property) && MANGLED.test(node.property.name)) {
            const name = node.property.name;
            seenMangled.add(name);
            if (hasOwn(reverse, name)) {
                node.property = bt.identifier(reverse[name]);
                renamedCount++;
            }
        }
        if (!node.computed && bt.isIdentifier(node.property) && MANGLED.test(node.property.name)) {
            unresolved.add(node.property.name);
        }
    };

    const keyVisitor = (path) => {
        const node = path.node;
        if (!node.computed || !bt.isStringLiteral(node.key)) return;
        const name = node.key.value;
        // { ["__proto__"]: x } defines an own property, { __proto__: x } sets the prototype.
        if (name === '__proto__' || !bt.isValidIdentifier(name, false)) return;
        node.key = bt.identifier(name);
        node.computed = false;
        keyCount++;
    };

    traverse(ast, {
        MemberExpression: memberVisitor,
        OptionalMemberExpression: memberVisitor,
        ObjectProperty: keyVisitor,
        ObjectMethod: keyVisitor,
    });

    console.log(`  Found ${seenMangled.size} unique .$N members; renamed ${renamedCount} occurrences.`);
    if (unresolved.size) console.log('  Unresolved .$N: ' + [...unresolved].join(', '));
    console.log(`  Normalized ${dotCount} x["y"] → x.y and ${keyCount} ["y"]: → y: keys.`);

    // ========================================================================
    // Return result
    // ========================================================================
    let remainingEs = 0;
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (bt.isMemberExpression(callee) && !callee.computed && bt.isIdentifier(callee.property, { name: 'es' })) remainingEs++;
        },
    });

    const code = generate(ast, { retainLines: false, compact: false }).code;
    const stats = {
        size: code.length,
        lines: code.split('\n').length,
        decoderReplaced,
        decoderFailed,
        tableReplaced,
        mangleMappings: Object.keys(reverse).length,
        remainingDollar: unresolved.size,
        remainingEs,
    };
    console.log('\n=== Complete ===');
    console.log('Size:', stats.size, 'bytes');
    console.log('Lines:', stats.lines);
    console.log('Remaining .$N members:', stats.remainingDollar);
    console.log('Remaining .es() calls:', stats.remainingEs);

    return { code, stats };
}

module.exports = { deobfuscate };
