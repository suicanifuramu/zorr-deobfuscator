const test = require('node:test');
const assert = require('node:assert');
const { deobfuscate } = require('../deobfuscator');

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

// Same shape as the zorr bundle, but with different identifier names (dec/arr/Zz/T instead
// of b/a/Cb/$) so the test fails if any name is hardcoded again.
const FIXTURE = `
(function () {
  let T;
  (function () {
    function q(n) { return ["alpha", "beta", "gamma"][n]; }
    T = [q(0), q(1), q(2)];
  })();
  const Zz = dec;
  function dec(n, t) {
    const e = arr();
    return (dec = function (n, t) { return e[n -= 100]; })(n, t);
  }
  function arr() {
    const n = ["zzz", "12", "hello", "world", "push"];
    return (arr = function () { return n; })();
  }
  (function (getArr, target) {
    const d = dec;
    const list = getArr();
    while (true) {
      try {
        if (parseInt(d(100)) === target) break;
        list.push(list.shift());
      } catch (e) {
        list.push(list.shift());
      }
    }
  })(arr, 12);
  (function () {
    const u = JSON.parse(atob("${b64({ floor: '$1' })}"));
    const w = JSON.parse(atob("${b64({ fillStyle: '$2' })}"));
    for (const k in u) if (k in window.Math) window.Math[u[k]] = window.Math[k];
    for (const k in w) window.Object.defineProperty(window.CanvasRenderingContext2D.prototype, w[k], {});
  })();
  (() => {
    const D = Zz;
    function inner() { const z = D; return z(101); }
    function shadow(Zz) { return Zz(101); }
    function local() { const T = [9]; return T[0]; }
    const s = "a.$1 and x[\\"foo\\"]: y";
    const v = cond ? ["foo"] : bar;
    ctx.$2 = T[0];
    ctx["$2"] = T[1];
    return Math.$1(1.5) + obj["bar"] + D(102) + inner() + shadow(f) + local();
  })();
})();
`;

function quietly(fn) {
    const log = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
    }
}

test('decodes string array calls through scope-traced aliases after rotation', () => {
    const { code } = quietly(() => deobfuscate(FIXTURE));
    // Without the rotation these would decode to "12"/"hello".
    assert.match(code, /function inner\(\) \{\s*const z = D;\s*return "hello";/);
    assert.match(code, /\+ "world" \+/);
    // A parameter that merely shares the alias name is not the decoder.
    assert.match(code, /function shadow\(Zz\) \{\s*return Zz\(101\);/);
});

test('inlines the string table without touching shadowing locals', () => {
    const { code } = quietly(() => deobfuscate(FIXTURE));
    assert.match(code, /ctx\.fillStyle = "alpha";/);
    assert.match(code, /ctx\.fillStyle = "beta";/);
    assert.match(code, /const T = \[9\];\s*return T\[0\];/);
});

test('renames .$N members from the runtime tables on the AST only', () => {
    const { code, stats } = quietly(() => deobfuscate(FIXTURE));
    assert.strictEqual(stats.mangleMappings, 2);
    assert.strictEqual(stats.remainingDollar, 0);
    assert.match(code, /Math\.floor\(1\.5\) \+ obj\.bar/);
    // String contents and array literals are left alone.
    assert.ok(code.includes('"a.$1 and x[\\"foo\\"]: y"'));
    assert.match(code, /cond \? \["foo"\] : bar/);
});

test('throws instead of exiting on unrecognized input', () => {
    assert.throws(() => quietly(() => deobfuscate('console.log(1);')), /string array/);
});
