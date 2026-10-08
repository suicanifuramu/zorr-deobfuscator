/**
 * isolated-vm sandbox for running code taken from the remote site.
 *
 * Decoders and other obfuscator machinery run in a separate V8 isolate: no access to
 * require/process/fs, bounded memory, and a timeout for loops that never converge.
 */
let ivm;
try {
    ivm = require('isolated-vm');
} catch (err) {
    throw new Error(
        'isolated-vm could not be loaded. Allow its native build (pnpm-workspace.yaml: ' +
        'allowBuilds.isolated-vm: true) and reinstall. Cause: ' + err.message
    );
}

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

// Values cross the isolate boundary as JSON; this tags primitives so that undefined, NaN,
// Infinity and -0 survive, and reports anything else as null (not inlinable).
const ENCODE = `
globalThis.__encode = (v) => {
    switch (typeof v) {
        case 'string': return ['s', v];
        case 'boolean': return ['b', v];
        case 'undefined': return ['u'];
        case 'number': return ['n', Object.is(v, -0) ? '-0' : String(v)];
        default: return v === null ? ['l'] : null;
    }
};
`;

function createSandbox() {
    const isolate = new ivm.Isolate({ memoryLimit: VM_MEMORY_MB });
    return {
        // Each context starts from the shims plus the given setup code.
        context(...setup) {
            const context = isolate.createContextSync();
            for (const code of [BASE64_SHIM, ENCODE, ...setup]) run(context, code);
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

module.exports = { createSandbox, run };
