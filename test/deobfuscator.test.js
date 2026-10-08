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
    for (const k in w) {
      window.Object.defineProperty(window.CanvasRenderingContext2D.prototype, w[k], {
        get() { return this[k]; },
        set(v) { this[k] = v; },
      });
    }
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

// A nested layer whose constant table is built with the outer decoder, and a second nested
// layer that keeps using its decoder from a timer callback (like the bundle's ge()).
const NESTED = `
(function () {
  function arr() {
    const n = ["xyz", "k1", "k2", "length", "undefined", "abc"];
    return (arr = function () { return n; })();
  }
  function dec(n) {
    const e = arr();
    return (dec = function (n) { return e[n - 10]; })(n);
  }
  (function () {
    const d = dec;
    const list = arr();
    while (true) {
      try {
        if (d(10) === "k1") break;
        list.push(list.shift());
      } catch (e) {
        list.push(list.shift());
      }
    }
  })();
  function mod() {
    const n = dec;
    var t;
    var e;
    const l = [0, 1, n(12), n(13)];
    function h(i) {
      if (typeof t[i] === l[3]) {
        return t[i] = e[i].split("").reverse().join("");
      } else {
        return t[i];
      }
    }
    F(t = {}, e = ["olleh", "dlrow"]);
    const out = { a: h(l[0]), b: h(l[1]), c: n(window.flag ? 14 : 15) };
    out[(typeof t[1] === l[3] ? t[1] = h(1) : t[1])] = out.a[l[2]];
    F(window.x = 1, window.y = 2);
    function F() { F = function () {}; }
    return out;
  }
  function live() {
    const n = dec;
    var t = {};
    const e = ["cba"];
    function g(i) {
      if (typeof t[i] === "undefined") return t[i] = e[i].split("").reverse().join("");
      return t[i];
    }
    setInterval(() => { t[0] = g(0); console.log(n(14), g(0)); }, 1000);
  }
  window.r = [mod(), live()];
})();
`;

// Readability rules that need no names, plus two things that must stay as they are.
const SIMPLE = `
(function () {
  function arr() {
    const n = ["p", "ab", "cd"];
    return (arr = function () { return n; })();
  }
  function dec(n) {
    const e = arr();
    return (dec = function (n) { return e[n]; })(n);
  }
  window.foo = window.bar;
  window.out = [
    function (o, x, y) { if (o === dec(0)) { return x + y; } }(dec(0), 2, 3),
    dec(1) + dec(2),
    { es() { return 1; } },
    window.foo,
  ];
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

const fixture = quietly(() => deobfuscate(FIXTURE));
const nested = quietly(() => deobfuscate(NESTED));
const simple = quietly(() => deobfuscate(SIMPLE));

test('decodes string array calls through scope-traced aliases after rotation', () => {
    const { code } = fixture;
    // Without the rotation these would decode to "12"/"hello".
    assert.match(code, /function inner\(\) \{\s*return "hello";/);
    assert.match(code, /\+ "world" \+/);
    // A parameter that merely shares the alias name is not the decoder.
    assert.match(code, /function shadow\(Zz\) \{\s*return Zz\(101\);/);
});

test('inlines the string table without touching shadowing locals', () => {
    const { code } = fixture;
    assert.match(code, /ctx\.fillStyle = "alpha";/);
    assert.match(code, /ctx\.fillStyle = "beta";/);
    assert.match(code, /const T = \[9\];\s*return T\[0\];/);
});

test('undoes member renames observed at run time, on the AST only', () => {
    const { code, stats } = fixture;
    assert.strictEqual(stats.memberAliases, 2);
    assert.doesNotMatch(code, /(ctx|Math)\.\$[12]\b/);
    assert.match(code, /Math\.floor\(1\.5\) \+ obj\.bar/);
    // String contents and array literals are left alone.
    assert.ok(code.includes('"a.$1 and x[\\"foo\\"]: y"'));
    assert.match(code, /cond \? \["foo"\] : bar/);
});

test('removes the machinery once nothing refers to it', () => {
    const { code } = fixture;
    for (const gone of ['function dec', 'function arr', 'parseInt', 'atob', 'const D = ', 'let T']) {
        assert.ok(!code.includes(gone), `${gone} should be gone`);
    }
});

test('peels a nested layer built on the outer decoder, after a rotator without arguments', () => {
    const { code } = nested;
    assert.match(code, /const out = \{\s*a: "hello",\s*b: "world",\s*c: window\.flag \? "abc" : "xyz"\s*\};/);
    assert.match(code, /out\.world = out\.a\.length;/);
    // No-op wrappers become plain statements.
    assert.match(code, /window\.x = 1;\s*window\.y = 2;/);
    assert.doesNotMatch(code, /function h\(|function F\(|"olleh"/);
});

test('leaves a layer operated from callbacks as it is, apart from outer decoder calls', () => {
    const { code, stats } = nested;
    assert.deepStrictEqual(stats.liveLayers.map(l => l.split(' ')[0]), ['live()']);
    assert.match(code, /const e = \["cba"\];/);
    assert.match(code, /t\[0\] = g\(0\);\s*console\.log\("abc", g\(0\)\);/);
    // The outer machinery stays for it, rotator included and still calling the decoder.
    assert.match(code, /function dec\(n\)/);
    assert.match(code, /if \(d\(10\) === "k1"\) \{?\s*break;/);
});

test('folds closed operator functions and literal concatenation', () => {
    const { code } = simple;
    assert.match(code, /window\.out = \[5, "abcd",/);
});

test('keeps ordinary members and assignments that only look like wrappers or aliases', () => {
    const { code } = simple;
    // An object method named like an old wrapper is ordinary code.
    assert.match(code, /es\(\) \{\s*return 1;/);
    // x.foo = x.bar written in the source is not a mangling table.
    assert.match(code, /window\.foo = window\.bar;/);
    assert.match(code, /window\.foo\s*\]/);
});

test('throws instead of exiting on unrecognized input', () => {
    assert.throws(() => quietly(() => deobfuscate('console.log(1);')), /string array/);
});
