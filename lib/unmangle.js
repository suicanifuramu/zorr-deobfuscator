/**
 * Member unmangling by observation.
 *
 * The obfuscator renames members of host objects and builtins (ctx.fillStyle → ctx.$31) and
 * ships code that defines the new names as aliases at run time. Top-level statements of the
 * original program that only depend on reproducible machinery are run against stub host
 * objects; every property they add that aliases another property of the same object (a copy
 * of its value, or an accessor reading or writing it) yields a mapping, which is then undone
 * on the AST. A name written in the defining statement's own source is an ordinary
 * assignment, not a mangle. A statement whose only effect was defining aliases is removed
 * once none of its names are left.
 */
const parser = require('@babel/parser');
const bt = require('@babel/types');
const { analyze } = require('./analysis');
const { findTopLevel } = require('./ast');
const { machineryContext } = require('./layers');
const { run } = require('./sandbox');

// Runs inside the sandbox. Unknown globals become stubs: any property is another stub
// (memoized), calls and construction return stubs, and names of the realm's own globals
// resolve to the real builtins, as they do on the global object. Writes are recorded.
const OBSERVER = `
(() => {
    const realm = globalThis;
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const builtin = new Set(Object.getOwnPropertyNames(realm));
    const stubs = new Map();          // proxy -> record
    const parentOf = new WeakMap();   // child stub -> [parent proxy, key]
    let hostCalls = 0;

    function stub() {
        const target = function () {};
        const rec = { target, keys: new Set(), writes: 0, children: new Map() };
        const proxy = new Proxy(target, {
            get(t, key, receiver) {
                if (rec.keys.has(key)) return Reflect.get(t, key, receiver);
                if (key === Symbol.toPrimitive) return () => '';
                if (typeof key !== 'string') return undefined;
                if (builtin.has(key) && own(realm, key)) return realm[key];
                let child = rec.children.get(key);
                if (!child) {
                    child = stub();
                    parentOf.set(child, [proxy, key]);
                    rec.children.set(key, child);
                }
                return child;
            },
            set(t, key, value, receiver) {
                rec.writes++;
                if (rec.keys.has(key) || own(t, key)) {
                    rec.keys.add(key);
                    return Reflect.set(t, key, value, receiver);
                }
                rec.keys.add(key);
                return Reflect.defineProperty(t, key, { value, writable: true, enumerable: true, configurable: true });
            },
            defineProperty(t, key, desc) {
                rec.writes++;
                rec.keys.add(key);
                return Reflect.defineProperty(t, key, desc);
            },
            deleteProperty(t, key) {
                rec.writes++;
                rec.keys.delete(key);
                return Reflect.deleteProperty(t, key);
            },
            has: (t, key) => typeof key === 'string' || Reflect.has(t, key),
            apply: () => (hostCalls++, stub()),
            construct: () => (hostCalls++, stub()),
        });
        stubs.set(proxy, rec);
        return proxy;
    }

    // Keys an accessor touches when called on a recording receiver.
    function touched(fn, args) {
        const keys = [];
        const receiver = new Proxy({}, {
            get(t, k) { if (typeof k === 'string') keys.push(k); return undefined; },
            set(t, k) { if (typeof k === 'string') keys.push(k); return true; },
        });
        try { fn.apply(receiver, args); } catch (e) {}
        return keys;
    }

    // The property \`key\` of \`obj\` (stored on \`target\`) aliases, or null.
    function aliasOf(obj, target, key) {
        const d = Reflect.getOwnPropertyDescriptor(target, key);
        if (!d) return null;
        if (d.get || d.set) {
            const keys = new Set([...(d.get ? touched(d.get, []) : []), ...(d.set ? touched(d.set, [undefined]) : [])]);
            keys.delete(key);
            return keys.size === 1 ? [...keys][0] : null;
        }
        const v = d.value;
        const isRef = v !== null && (typeof v === 'object' || typeof v === 'function');
        const parent = isRef ? parentOf.get(v) : undefined;
        if (parent) return parent[0] === obj && parent[1] !== key ? parent[1] : null;
        const matches = new Set();
        for (let o = target; o; o = Object.getPrototypeOf(o)) {
            for (const k of Object.getOwnPropertyNames(o)) {
                if (k === key) continue;
                const e = Object.getOwnPropertyDescriptor(o, k);
                if (e && 'value' in e && Object.is(e.value, v)) matches.add(k);
            }
        }
        if (!matches.size || (!isRef && matches.size > 1)) return null;
        return [...matches][0];
    }

    function realObjects() {
        const out = new Set([realm]);
        for (const k of Object.getOwnPropertyNames(realm)) {
            const d = Object.getOwnPropertyDescriptor(realm, k);
            const v = d && d.value;
            if (!v || (typeof v !== 'object' && typeof v !== 'function') || stubs.has(v)) continue;
            out.add(v);
            const p = Object.getOwnPropertyDescriptor(v, 'prototype');
            if (p && p.value && (typeof p.value === 'object' || typeof p.value === 'function')) out.add(p.value);
        }
        return out;
    }

    let snap = null;
    globalThis.__observer = {
        stubGlobals(names) {
            for (const n of names) if (!(n in realm)) realm[n] = stub();
        },
        snapshot() {
            const real = new Map();
            for (const o of realObjects()) {
                const descs = new Map();
                for (const k of Reflect.ownKeys(o)) descs.set(k, Reflect.getOwnPropertyDescriptor(o, k));
                real.set(o, descs);
            }
            const recs = new Map([...stubs].map(([p, rec]) => [p, { keys: new Set(rec.keys), writes: rec.writes }]));
            snap = { real, recs, hostCalls };
        },
        collect() {
            const aliases = [];
            let others = hostCalls - snap.hostCalls;
            for (const [o, before] of snap.real) {
                for (const k of Reflect.ownKeys(o)) {
                    const d = Reflect.getOwnPropertyDescriptor(o, k);
                    const old = before.get(k);
                    if (old) {
                        if (!['value', 'get', 'set'].every(f => Object.is(old[f], d[f]))) others++;
                        continue;
                    }
                    const a = typeof k === 'string' ? aliasOf(o, o, k) : null;
                    if (a) aliases.push([k, a]); else others++;
                }
                for (const k of before.keys()) if (!Reflect.getOwnPropertyDescriptor(o, k)) others++;
            }
            for (const [proxy, rec] of stubs) {
                const before = snap.recs.get(proxy) || { keys: new Set(), writes: 0 };
                let fresh = 0;
                for (const k of rec.keys) {
                    if (before.keys.has(k)) continue;
                    fresh++;
                    const a = typeof k === 'string' ? aliasOf(proxy, rec.target, k) : null;
                    if (a) aliases.push([k, a]); else others++;
                }
                others += Math.max(0, rec.writes - before.writes - fresh);
            }
            return { aliases, others };
        },
    };
})();
`;

// A statement that can run against the reproduced machinery: everything it refers to
// outside itself is static.
function runnable(stmt, r) {
    if (!stmt.isExpressionStatement()) return false;
    for (const b of r.freeBindingsOf(stmt)) if (!r.staticSet.has(b)) return false;
    return true;
}

// Names written anywhere in a statement's source (identifiers and string contents).
function namesIn(stmt) {
    const names = new Set();
    const visit = (p) => {
        if (p.isIdentifier()) names.add(p.node.name);
        else if (p.isStringLiteral()) names.add(p.node.value);
        else if (p.isTemplateElement()) names.add(p.node.value.cooked);
    };
    stmt.traverse({ 'Identifier|StringLiteral|TemplateElement': visit });
    return names;
}

// Property names the program defines itself (object/class keys, string keys).
function definedKeys(programPath) {
    const keys = new Set();
    const add = (node) => {
        if (bt.isIdentifier(node)) keys.add(node.name);
        else if (bt.isStringLiteral(node)) keys.add(node.value);
    };
    programPath.traverse({
        'ObjectProperty|ObjectMethod|ClassMethod|ClassProperty'(p) {
            if (!p.node.computed || bt.isStringLiteral(p.node.key)) add(p.node.key);
        },
    });
    return keys;
}

function memberName(node) {
    if (!node.computed && bt.isIdentifier(node.property)) return node.property.name;
    if (node.computed && bt.isStringLiteral(node.property)) return node.property.value;
    return null;
}

// Observation runs on the original program, parsed afresh: the obfuscator's decoders share
// caches, so code with some of its decoder calls already inlined would not behave the same.
// Statements holding a live layer are not run at all. The mappings are then applied to the
// deobfuscated AST.
function unmangle(ast, sandbox, { source, forced = new Set(), frozen = new Set(), liveScopes = new Set(), log = () => {} } = {}) {
    const original = analyze(parser.parse(source, { sourceType: 'script' }));
    // Statements holding any live layer (frozen or decoded from callbacks) are not observed:
    // their callbacks would be reinstalled against the stubs rather than reproduced.
    const liveBlocks = new Set([...frozen, ...liveScopes]);
    const holdsLiveLayer = (stmt) => [...liveBlocks].some(block => block.start >= stmt.node.start && block.end <= stmt.node.end);
    const candidates = findTopLevel(original.programPath).filter(s => runnable(s, original) && !holdsLiveLayer(s));
    const stats = { statements: candidates.length, mappings: 0, renamed: 0, removed: 0, conflicts: [] };
    if (!candidates.length) return stats;

    const roots = new Set();
    for (const s of candidates) for (const b of original.freeBindingsOf(s)) roots.add(b);
    const unknown = new Set();
    for (const s of candidates) {
        s.traverse({ ReferencedIdentifier(p) { if (!p.scope.getBinding(p.node.name)) unknown.add(p.node.name); } });
    }

    const { ctx, codeOf } = machineryContext(original, roots, sandbox);
    let results;
    try {
        run(ctx, OBSERVER);
        run(ctx, `__observer.stubGlobals(${JSON.stringify([...unknown])})`);
        const codes = codeOf(candidates.map(s => s.node));
        results = candidates.map((stmt, i) => {
            run(ctx, '__observer.snapshot()');
            let error = null;
            try {
                run(ctx, codes[i]);
            } catch (err) {
                error = String(err && err.message || err);
            }
            return { stmt, error, ...JSON.parse(run(ctx, 'JSON.stringify(__observer.collect())')) };
        });
    } finally {
        ctx.release();
    }

    // A mangling table hides the new names in data: a name written in the defining
    // statement itself is an ordinary assignment (x.a = x.b), not a mangle.
    for (const result of results) {
        const written = namesIn(result.stmt);
        result.aliases = result.aliases.filter(([alias]) => !written.has(alias));
    }

    // alias -> original; a name defined differently twice, or defined by the program
    // itself, is left alone.
    const r = analyze(ast, { forced });
    const defined = definedKeys(r.programPath);
    const mapping = new Map();
    const ambiguous = new Set();
    for (const { aliases } of results) {
        for (const [alias, real] of aliases) {
            if (mapping.has(alias) && mapping.get(alias) !== real) ambiguous.add(alias);
            mapping.set(alias, real);
        }
    }
    for (const alias of [...mapping.keys()]) {
        if (ambiguous.has(alias) || defined.has(alias)) {
            stats.conflicts.push(alias);
            mapping.delete(alias);
        }
    }
    stats.mappings = mapping.size;
    for (const { stmt, aliases, others, error } of results) {
        if (aliases.length) {
            log(`  Statement at line ${stmt.node.loc?.start.line} defines ${aliases.length} member aliases` +
                (others ? ` and has ${others} other effects` : '') + (error ? ` (stopped: ${error})` : ''));
        }
    }
    if (!mapping.size) return stats;

    r.programPath.traverse({
        'MemberExpression|OptionalMemberExpression'(p) {
            const name = memberName(p.node);
            if (name === null || !mapping.has(name)) return;
            const real = mapping.get(name);
            if (p.node.computed) p.node.property = bt.stringLiteral(real);
            else if (bt.isValidIdentifier(real, false)) p.node.property = bt.identifier(real);
            else {
                p.node.property = bt.stringLiteral(real);
                p.node.computed = true;
            }
            stats.renamed++;
        },
    });

    // Statements that did nothing but define aliases are gone once their names are.
    const left = new Set();
    r.programPath.traverse({
        'MemberExpression|OptionalMemberExpression'(p) {
            const name = memberName(p.node);
            if (name !== null) left.add(name);
        },
    });
    const byStart = new Map(findTopLevel(r.programPath).map(s => [s.node.start, s]));
    for (const { stmt, aliases, others, error } of results) {
        if (!aliases.length || others || error) continue;
        if (aliases.some(([alias]) => left.has(alias) || !mapping.has(alias))) continue;
        const target = byStart.get(stmt.node.start);
        if (!target) continue;
        log(`  Removed the alias-defining statement at line ${stmt.node.loc?.start.line}.`);
        target.remove();
        stats.removed++;
    }
    return stats;
}

module.exports = { unmangle };
