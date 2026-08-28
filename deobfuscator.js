/**
 * Zorr Deobfuscator v2 — Self-contained, fully automated.
 * 
 * Takes webcracked.js and produces zorr-deobfuscated.js.
 * Dynamically extracts and executes the decoder from the source itself.
 * No external JSON data files required.
 */
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const bt = require('@babel/types');
const vm = require('vm');

console.log('=== Zorr Deobfuscator v2 ===');
const sourceCode = fs.readFileSync('webcracked.js', 'utf8');

// ========================================================================
// PHASE 1: Parse AST and extract decoder infrastructure
// ========================================================================
console.log('Phase 1: Parsing source and extracting decoder...');
const ast = parser.parse(sourceCode, { sourceType: 'script' });
const topBody = ast.program.body[0].expression.callee.body.body;

// Identify the top-level nodes:
// node[0]: let $
// node[1]: function b(e, t) — outer decoder
// node[2]: IIFE — inner d() decoder setup  
// node[3]: const Cb = b — alias
// node[4]: function a() — string array
// node[5]: shuffle IIFE
// The rest: main code IIFEs

// Find function a(), function b(), shuffle IIFE, and inner d() decoder IIFE
let funcA = null, funcB = null, shuffleIIFE = null, innerDecoderIIFE = null;
for (const node of topBody) {
    if (node.type === 'FunctionDeclaration' && node.id) {
        if (node.id.name === 'a') funcA = node;
        if (node.id.name === 'b') funcB = node;
    }
    // Identify IIFEs
    if (node.type === 'ExpressionStatement' && 
        bt.isCallExpression(node.expression) &&
        bt.isFunctionExpression(node.expression.callee)) {
        const fn = node.expression.callee;
        const fnCode = generate(node).code;
        
        // The shuffle IIFE has 2 parameters and contains parseInt + while
        if (fn.params.length === 2 && fnCode.includes('parseInt') && fnCode.includes('while')) {
            shuffleIIFE = node;
        }
        // The inner d() decoder IIFE has 0 parameters and defines function d(
        // Take the FIRST match — the early decoder IIFE, not the main game IIFE
        else if (!innerDecoderIIFE && fn.params.length === 0 && fnCode.includes('function d(') && fnCode.includes('const l = [')) {
            innerDecoderIIFE = node;
        }
    }
}

if (!funcA || !funcB || !shuffleIIFE) {
    console.error('FATAL: Could not find a(), b(), or shuffle IIFE in source.');
    console.error('  funcA:', !!funcA, 'funcB:', !!funcB, 'shuffleIIFE:', !!shuffleIIFE);
    process.exit(1);
}
console.log('  Found function a() at line', funcA.loc.start.line);
console.log('  Found function b() at line', funcB.loc.start.line);
console.log('  Found shuffle IIFE at line', shuffleIIFE.loc.start.line);

// ========================================================================
// PHASE 2: Execute decoder in VM sandbox
// ========================================================================
console.log('Phase 2: Building VM decoder...');
const aCode = generate(funcA).code;
const bCode = generate(funcB).code;
const shuffleCode = generate(shuffleIIFE).code;

const vmSetup = `
${aCode}
${bCode}
${shuffleCode}
globalThis.__b = b;
`;

const vmContext = vm.createContext({ parseInt, console });
vm.runInContext(vmSetup, vmContext);

// Test the decoder
const testResult = vmContext.__b(568);  // should be "push" based on our earlier test
console.log('  VM decoder test: b(568) =', JSON.stringify(testResult));

function decodeB(val) {
    try {
        return vm.runInContext(`__b(${val})`, vmContext);
    } catch (e) {
        return undefined;
    }
}

// ========================================================================
// PHASE 3: Build the inner d() decoder context
// ========================================================================
console.log('Phase 3: Building inner d() decoder context...');

let innerDecoderReady = false;
let innerVmContext = null;

if (innerDecoderIIFE) {
    try {
        const innerBody = innerDecoderIIFE.expression.callee.body.body;
        
        // Extract nodes 0-13: variable declarations, l array, d(), h(), g(), 
        // e/t data setup (node 13). Skip node 14 (anti-tamper globalThis resolver)
        // and instead directly provide the globals that h() needs (o, s, a, i, r, c).
        const pieces = [];
        for (let i = 0; i <= 13 && i < innerBody.length; i++) {
            pieces.push(generate(innerBody[i]).code);
        }
        
        // After the data setup, manually assign the variables that node 14 would set
        const globalsSetup = `
            o = TextDecoder;
            s = Uint8Array;
            a = Buffer;
            i = String;
            r = Array;
        `;
        
        const dSetupCode = pieces.join('\n') + '\n' + globalsSetup + '\nglobalThis.__d = d;\n';
        
        innerVmContext = vm.createContext({ 
            Buffer, console, parseInt, atob, btoa,
            String, Array, Object, Math, Number,
            TextDecoder, Uint8Array,
            globalThis: {}
        });
        
        vm.runInContext(dSetupCode, innerVmContext);
        innerDecoderReady = true;
        
        // Access __d from the globalThis sub-object
        const innerD = innerVmContext.globalThis.__d;
        
        // Test
        const dTest = innerD(84);
        console.log('  Inner d() decoder ready. d(84) =', JSON.stringify(dTest));
    } catch (err) {
        console.log('  Warning: Inner d() decoder setup failed:', err.message);
        console.log('  Stack:', err.stack.split('\n').slice(0, 5).join('\n'));
        console.log('  Will skip d() resolution.');
    }
}

// ========================================================================
// PHASE 4: Collect all alias names that trace back to b/Cb
// ========================================================================
console.log('Phase 4: Tracing decoder alias chain...');

// We need to find all variables that are assigned from b, Cb, or any alias of them
const decoderRoots = new Set(['b', 'Cb']);
const decoderAliases = new Set(['b', 'Cb']);
let changed = true;

// Iteratively find all aliases
while (changed) {
    changed = false;
    traverse(ast, {
        VariableDeclarator(path) {
            if (bt.isIdentifier(path.node.init) && 
                decoderAliases.has(path.node.init.name) &&
                !decoderAliases.has(path.node.id.name)) {
                decoderAliases.add(path.node.id.name);
                changed = true;
            }
        },
        noScope: true
    });
}

console.log(`  Found ${decoderAliases.size} decoder alias names: ${[...decoderAliases].join(', ')}`);

// ========================================================================
// PHASE 5: AST traversal — replace all decoder calls
// ========================================================================
console.log('Phase 5: Replacing decoder calls...');

let bReplacedCount = 0;
let bFailedCount = 0;
let dReplacedCount = 0;
let dFailedCount = 0;
let esRemovedCount = 0;

traverse(ast, {
    CallExpression(path) {
        const callee = path.node.callee;
        
        // --- Handle b/Cb/alias(N) calls ---
        if (bt.isIdentifier(callee) && 
            decoderAliases.has(callee.name) && 
            path.node.arguments.length >= 1 &&
            bt.isNumericLiteral(path.node.arguments[0])) {
            
            // Verify this binding actually traces back to a decoder root
            const binding = path.scope.getBinding(callee.name);
            let isDecoder = false;
            if (binding) {
                const initNode = binding.path.node;
                if (bt.isVariableDeclarator(initNode) && 
                    bt.isIdentifier(initNode.init) && 
                    decoderAliases.has(initNode.init.name)) {
                    isDecoder = true;
                }
                if (callee.name === 'b' || callee.name === 'Cb') {
                    isDecoder = true;
                }
                if (bt.isVariableDeclarator(initNode) && 
                    bt.isIdentifier(initNode.init) &&
                    (initNode.init.name === 'Cb' || initNode.init.name === 'b' || initNode.init.name === 'Ce')) {
                    isDecoder = true;
                }
            }
            
            // If confirmed as b/Cb decoder alias, resolve it
            if (isDecoder) {
                const val = path.node.arguments[0].value;
                const decoded = decodeB(val);
                if (decoded !== undefined && decoded !== null) {
                    path.replaceWith(bt.stringLiteral(decoded));
                    bReplacedCount++;
                } else {
                    bFailedCount++;
                }
                return;
            }
            // Otherwise fall through — it may be the inner d() decoder
        }
        
        // --- Handle inner d(N) calls ---
        if (innerDecoderReady && bt.isIdentifier(callee, { name: 'd' }) &&
            path.node.arguments.length >= 1 && bt.isNumericLiteral(path.node.arguments[0])) {
            const binding = path.scope.getBinding('d');
            // Only replace if d refers to the decoder (defined in early lines)
            if (binding && binding.path.node.loc && binding.path.node.loc.start.line < 200) {
                const val = path.node.arguments[0].value;
                try {
                    const decoded = innerVmContext.globalThis.__d(val);
                    if (decoded !== undefined && decoded !== null) {
                        path.replaceWith(bt.stringLiteral(decoded));
                        dReplacedCount++;
                    } else {
                        dFailedCount++;
                    }
                } catch (e) {
                    dFailedCount++;
                }
            }
            return;
        }
        
        // --- Handle .es() wrapper removal ---
        if (bt.isMemberExpression(callee) && 
            bt.isIdentifier(callee.property, { name: 'es' }) &&
            path.node.arguments.length === 1) {
            path.replaceWith(path.node.arguments[0]);
            esRemovedCount++;
        }
    },
    ObjectMethod(path) {
        if (path.node.key && bt.isIdentifier(path.node.key, { name: 'es' })) {
            path.remove();
        }
    },
    ClassMethod(path) {
        if (path.node.key && bt.isIdentifier(path.node.key, { name: 'es' })) {
            path.remove();
        }
    }
});

console.log(`  b/Cb decoder: ${bReplacedCount} replaced, ${bFailedCount} failed`);
console.log(`  d() decoder: ${dReplacedCount} replaced, ${dFailedCount} failed`);
console.log(`  .es() wrappers: ${esRemovedCount} removed`);

// ========================================================================
// PHASE 5.5: Resolve $[N] array lookups
// ========================================================================
console.log('Phase 5.5: Resolving $[N] array lookups...');

let dollarArray = null;

// Strategy 1: Execute the inner IIFE that populates $ via its own g() decoder.
// The $ array is built by g() calls — a decoder local to an inner IIFE, completely
// separate from the outer b() decoder. We must execute this IIFE in a VM to get
// the actual decoded string values.
for (const node of topBody) {
    if (dollarArray) break;
    if (node.type !== 'ExpressionStatement') continue;
    if (!bt.isCallExpression(node.expression)) continue;
    if (!bt.isFunctionExpression(node.expression.callee)) continue;
    
    const fnBody = node.expression.callee.body.body;
    let hasDollarArrayAssign = false;
    for (const stmt of fnBody) {
        if (!bt.isExpressionStatement(stmt)) continue;
        const expr = stmt.expression;
        // Direct: $ = [...]
        if (bt.isAssignmentExpression(expr) && 
            bt.isIdentifier(expr.left, { name: '$' }) &&
            bt.isArrayExpression(expr.right)) {
            hasDollarArrayAssign = true;
            break;
        }
        // Wrapped in a call like h($ = [...], ...)
        if (bt.isCallExpression(expr)) {
            for (const arg of expr.arguments) {
                if (bt.isAssignmentExpression(arg) &&
                    bt.isIdentifier(arg.left, { name: '$' }) &&
                    bt.isArrayExpression(arg.right)) {
                    hasDollarArrayAssign = true;
                    break;
                }
            }
        }
        if (hasDollarArrayAssign) break;
    }
    
    if (hasDollarArrayAssign) {
        console.log('  Found IIFE that populates $ array. Executing in VM...');
        try {
            const iifeCode = generate(node).code;
            const sandbox = {
                parseInt,
                TextDecoder, Uint8Array, Buffer,
                String, Array, Object, Math, Number,
                atob, btoa,
            };
            sandbox.globalThis = sandbox;
            sandbox.global = sandbox;
            const dollarCtx = vm.createContext(sandbox);
            vm.runInContext('var $;', dollarCtx);
            vm.runInContext(iifeCode, dollarCtx);
            if (Array.isArray(dollarCtx.$) && dollarCtx.$.length > 0) {
                dollarArray = dollarCtx.$;
                console.log(`  VM success: ${dollarArray.length} elements.`);
                console.log(`  Samples: $[0]=${JSON.stringify(dollarArray[0])}, $[51]=${JSON.stringify(dollarArray[51])}, $[95]=${JSON.stringify(dollarArray[95])}`);
            }
        } catch(e) {
            console.log('  Warning: VM execution failed:', e.message);
        }
    }
}

// Strategy 2: Fall back to AST-based extraction (handles already-decoded arrays)
if (!dollarArray) {
    traverse(ast, {
        AssignmentExpression(path) {
            if (bt.isIdentifier(path.node.left, { name: '$' }) && 
                bt.isArrayExpression(path.node.right)) {
                const elements = path.node.right.elements;
                dollarArray = [];
                for (const el of elements) {
                    if (bt.isStringLiteral(el)) {
                        dollarArray.push(el.value);
                    } else {
                        if (innerDecoderReady && bt.isCallExpression(el) && 
                            bt.isIdentifier(el.callee, { name: 'd' })) {
                            let val = null;
                            if (el.arguments.length > 0) {
                                if (bt.isNumericLiteral(el.arguments[0])) {
                                    val = el.arguments[0].value;
                                } else if (bt.isMemberExpression(el.arguments[0]) &&
                                           bt.isIdentifier(el.arguments[0].object, { name: 'l' }) &&
                                           bt.isNumericLiteral(el.arguments[0].property)) {
                                    try {
                                        val = vm.runInContext('l[' + el.arguments[0].property.value + ']', innerVmContext);
                                    } catch(e) {}
                                }
                            }
                            if (val !== null) {
                                try {
                                    const decoded = innerVmContext.globalThis.__d(val);
                                    dollarArray.push(decoded || '');
                                } catch(e) {
                                    dollarArray.push('');
                                }
                            } else {
                                dollarArray.push('');
                            }
                        } else {
                            dollarArray.push(null);
                        }
                    }
                }
                path.stop();
            }
        }
    });
    if (dollarArray) {
        console.log(`  AST fallback: Found $ array with ${dollarArray.length} elements.`);
    }
}

if (dollarArray) {
    console.log(`  $ array: ${dollarArray.length} elements.`);
    
    // Replace all $[N] member expressions
    let dollarReplacedCount = 0;
    traverse(ast, {
        MemberExpression(path) {
            if (bt.isIdentifier(path.node.object, { name: '$' }) &&
                bt.isNumericLiteral(path.node.property) &&
                path.node.computed) {
                // Skip if $[N] is on the left side of an assignment
                if (path.parentPath && bt.isAssignmentExpression(path.parentPath.node) &&
                    path.parentPath.node.left === path.node) {
                    return;
                }
                // Skip if $ is a locally-scoped variable (not the string array)
                const binding = path.scope.getBinding('$');
                if (binding) {
                    const decl = binding.path.node;
                    if (bt.isVariableDeclarator(decl) && decl.init &&
                        !bt.isArrayExpression(decl.init)) {
                        return; // local $ (e.g. const $ = Math.cos(i) * r)
                    }
                }
                const idx = path.node.property.value;
                if (idx >= 0 && idx < dollarArray.length && dollarArray[idx] != null) {
                    path.replaceWith(bt.stringLiteral(String(dollarArray[idx])));
                    dollarReplacedCount++;
                }
            }
        }
    });
    console.log(`  Replaced ${dollarReplacedCount} $[N] lookups.`);
} else {
    console.log('  Warning: Could not find $ array assignment.');
}


// NEW PHASE 6 — paste into deobfuscator.js replacing lines 367-687
// Auto-detect .$N property mangles using context heuristics

console.log('Phase 6: Auto-detecting .$N property mangle mappings...');
let code = generate(ast, { retainLines: false, compact: false }).code;

function countP(p) { return (code.match(p) || []).length; }
const allDn = new Set();
{ let m; const re = /\.(\$\d+)/g; while (m = re.exec(code)) allDn.add(m[1]); }
console.log('  Found ' + allDn.size + ' unique .$N patterns.');

const detected = {}; // dn → { name, scope }

// ── MATH: only $N used exclusively on Math ──
const mathDns = [];
for (const dn of allDn) {
    const n = dn.slice(1);
    const mc = countP(new RegExp('Math\\.\\$' + n + '\\(', 'g'));
    const tc = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
    const tp = countP(new RegExp('\\.\\$' + n + '(?![\\d(])', 'g'));
    if (mc > 0 && mc === tc + tp) mathDns.push({ dn, count: mc });
}

// Classify each Math.$N by argument/usage signature
for (const { dn, count } of mathDns) {
    const n = dn.slice(1);
    const zeroArg = countP(new RegExp('Math\\.\\$' + n + '\\(\\)', 'g'));
    const twoArg = countP(new RegExp('Math\\.\\$' + n + '\\([^,)]+,\\s*[^,)]+\\)', 'g'));
    const multAfter = countP(new RegExp('Math\\.\\$' + n + '\\([^)]+\\)\\s*\\*', 'g'));
    const wrapsM = countP(new RegExp('Math\\.\\$' + n + '\\(Math\\.', 'g'));

    if (zeroArg > count * 0.5) detected[dn] = { name: 'random', scope: 'Math' };
    else if (twoArg > count * 0.4) detected[dn] = { name: '_2arg', scope: 'Math' };
    else if (multAfter > count * 0.6) detected[dn] = { name: '_trig', scope: 'Math' };
    else if (wrapsM > count * 0.15) detected[dn] = { name: '_wrap', scope: 'Math' };
    else if (count > 20) detected[dn] = { name: '_1arg', scope: 'Math' };
    else detected[dn] = { name: 'sign', scope: 'Math' };
}

// Disambiguate _trig → cos/sin pair (cos for X in lineTo, sin for Y)
const trigs = Object.entries(detected).filter(([,v]) => v.name === '_trig');
if (trigs.length >= 2) {
    // Find which appears first in lineTo-like context (X position = cos)
    trigs.sort((a, b) => {
        const ai = code.indexOf('Math.' + a[0] + '(');
        const bi = code.indexOf('Math.' + b[0] + '(');
        return ai - bi;
    });
    // In lineTo(cos(a)*r, sin(a)*r), cos comes first (X), sin second (Y)
    detected[trigs[0][0]].name = 'cos';
    detected[trigs[1][0]].name = 'sin';
    for (let i = 2; i < trigs.length; i++) detected[trigs[i][0]].name = 'abs';
} else if (trigs.length === 1) {
    detected[trigs[0][0]].name = 'abs'; // single high-mult = abs
}

// Disambiguate _2arg → pow, min, max, hypot, atan2
const twoArgs = Object.entries(detected).filter(([,v]) => v.name === '_2arg');
for (const [dn] of twoArgs) {
    const n = dn.slice(1);
    const count = mathDns.find(x => x.dn === dn).count;
    // atan2 has (dy,dx) with subtraction patterns
    const subArg = countP(new RegExp('Math\\.\\$' + n + '\\([^,]*-[^,]+,\\s*[^)]*-', 'g'));
    // max often clamps to 0: Math.$N(value, 0)
    const zeroClamp = countP(new RegExp('Math\\.\\$' + n + '\\([^,]+,\\s*0\\)', 'g'));
    const zeroFirst = countP(new RegExp('Math\\.\\$' + n + '\\(0,', 'g'));
    // pow has small exponent: Math.$N(base, 0.5/2/3/0.7)
    const smallExp = countP(new RegExp('Math\\.\\$' + n + '\\([^,]+,\\s*[0-3](\\.\\d)?\\)', 'g'));
    
    if (count < 10 && subArg > 0) detected[dn].name = 'atan2';
    else if (smallExp > count * 0.2) detected[dn].name = 'pow';
    else if (zeroClamp > count * 0.1 || zeroFirst > count * 0.1) detected[dn].name = 'max';
    else if (count > 40) detected[dn].name = 'min';
    else detected[dn].name = 'hypot';
}
// If both min and max detected, verify by count (max usually > min)
const minMax = Object.entries(detected).filter(([,v]) => v.name === 'min' || v.name === 'max');
if (minMax.length === 2) {
    const [a, b] = minMax;
    const ac = mathDns.find(x => x.dn === a[0]).count;
    const bc = mathDns.find(x => x.dn === b[0]).count;
    if (ac > bc) { detected[a[0]].name = 'max'; detected[b[0]].name = 'min'; }
    else { detected[a[0]].name = 'min'; detected[b[0]].name = 'max'; }
}

// Disambiguate _wrap → floor, round, ceil (by frequency: floor >> round > ceil)
const wraps = Object.entries(detected).filter(([,v]) => v.name === '_wrap');
wraps.sort((a, b) => mathDns.find(x => x.dn === b[0]).count - mathDns.find(x => x.dn === a[0]).count);
const wrapNames = ['floor', 'round', 'ceil', 'trunc'];
wraps.forEach(([dn], i) => { detected[dn].name = wrapNames[Math.min(i, wrapNames.length - 1)]; });

// Disambiguate _1arg → abs (highest count remaining)
const oneArgs = Object.entries(detected).filter(([,v]) => v.name === '_1arg');
oneArgs.sort((a, b) => mathDns.find(x => x.dn === b[0]).count - mathDns.find(x => x.dn === a[0]).count);
if (oneArgs.length > 0) detected[oneArgs[0][0]].name = 'abs';
for (let i = 1; i < oneArgs.length; i++) detected[oneArgs[i][0]].name = 'sign';

// ── DOCUMENT: only $N used exclusively on document ──
for (const dn of allDn) {
    if (detected[dn]) continue;
    const n = dn.slice(1);
    const dc = countP(new RegExp('document\\.\\$' + n + '\\(', 'g'));
    const tc = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
    const tp = countP(new RegExp('\\.\\$' + n + '(?![\\d(])', 'g'));
    if (dc > 0 && dc === tc + tp) {
        const tag = countP(new RegExp('document\\.\\$' + n + '\\("(?:style|canvas|script|link|div|span|img|input)"', 'g'));
        const sel = countP(new RegExp('document\\.\\$' + n + '\\("[\\[.#]', 'g'));
        const evt = countP(new RegExp('document\\.\\$' + n + '\\("(?:click|mouse|key|touch|scroll|resize|pointer|wheel|DOM|load)', 'g'));
        if (tag > 0) detected[dn] = { name: 'createElement', scope: 'document' };
        else if (sel > 0) detected[dn] = { name: 'querySelectorAll', scope: 'document' };
        else if (evt > 0) detected[dn] = { name: 'addEventListener', scope: 'document' };
        else detected[dn] = { name: 'querySelector', scope: 'document' };
    }
}

// ── CANVAS PROPERTIES: pure props (NEVER called as method) with distinctive values ──
for (const dn of allDn) {
    if (detected[dn]) continue;
    const n = dn.slice(1);
    const callC = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
    if (callC > 0) continue; // MUST be pure property, never called
    const propC = countP(new RegExp('\\.\\$' + n + '\\s*=', 'g'));
    if (propC === 0) continue;

    const colorV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*(?:this\\.As\\(|"(?:rgba|hsla|#))', 'g'));
    const roundV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*"(?:round|butt|square|miter|bevel)"', 'g'));
    const fontV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*"(?:bolder|bold|normal|italic)\\s', 'g'));
    const baseV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*"(?:top|middle|bottom|alphabetic)"', 'g'));
    const alignV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*"(?:center|left|right|start|end)"', 'g'));
    const compV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*"(?:source-|destination-|lighter)"', 'g'));
    const negV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*-', 'g'));

    if (colorV > propC * 0.3 && propC > 100) detected[dn] = { name: 'fillStyle', scope: 'prop' };
    else if (colorV > propC * 0.3 && propC > 5) detected[dn] = { name: 'shadowColor', scope: 'prop' };
    else if (roundV > 0) detected[dn] = { name: '_jc', scope: 'prop' };
    else if (fontV > 0) detected[dn] = { name: 'font', scope: 'prop' };
    else if (baseV > 0) detected[dn] = { name: 'textBaseline', scope: 'prop' };
    else if (alignV > 0) detected[dn] = { name: 'textAlign', scope: 'prop' };
    else if (compV > 0) detected[dn] = { name: 'globalCompositeOperation', scope: 'prop' };
    else if (propC > 50) detected[dn] = { name: 'lineWidth', scope: 'prop' };
    else if (propC > 10) {
        const decV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*0?\\.\\d', 'g'));
        detected[dn] = { name: decV > propC * 0.15 ? 'globalAlpha' : 'strokeStyle', scope: 'prop' };
    }
    else if (propC > 3) detected[dn] = { name: 'shadowBlur', scope: 'prop' };
    else if (negV > 0) detected[dn] = { name: 'shadowOffsetX', scope: 'prop' };
    else if (propC <= 2) detected[dn] = { name: 'imageSmoothingQuality', scope: 'prop' };
}
// Disambiguate lineJoin/lineCap pair
const jcs = Object.entries(detected).filter(([,v]) => v.name === '_jc');
if (jcs.length === 2) {
    const [a, b] = jcs.map(([k]) => k);
    const ai = code.indexOf('.' + a), bi = code.indexOf('.' + b);
    detected[ai < bi ? a : b].name = 'lineJoin';
    detected[ai < bi ? b : a].name = 'lineCap';
} else jcs.forEach(([k]) => { detected[k].name = 'lineJoin'; });

// ── CANVAS/PATH2D METHODS: distinctive call signatures ──
// Find lineTo first (high freq + Math trig args)
let lineToVar = null;
for (const dn of allDn) {
    if (detected[dn]) continue;
    const n = dn.slice(1);
    const callC = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
    if (callC < 400) continue;
    const trigArg = countP(new RegExp('\\.\\$' + n + '\\(Math\\.', 'g'));
    if (trigArg > callC * 0.05) {
        detected[dn] = { name: 'lineTo', scope: 'method' };
        const vm = code.match(new RegExp('(\\w+)\\.\\$' + n + '\\(', 'g'));
        if (vm) {
            const vars = {};
            vm.forEach(v => { const vn = v.split('.')[0]; vars[vn] = (vars[vn]||0)+1; });
            lineToVar = Object.entries(vars).sort((a,b) => b[1]-a[1])[0][0];
        }
        break;
    }
}
// moveTo: similar count, same primary variable as lineTo
if (lineToVar) {
    for (const dn of allDn) {
        if (detected[dn]) continue;
        const n = dn.slice(1);
        const callC = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
        if (callC < 300 || callC > 800) continue;
        const onVar = countP(new RegExp(lineToVar + '\\.\\$' + n + '\\(', 'g'));
        if (onVar > callC * 0.8) { detected[dn] = { name: 'moveTo', scope: 'method' }; break; }
    }
}
// Other methods with very distinctive signatures
for (const dn of allDn) {
    if (detected[dn]) continue;
    const n = dn.slice(1);
    const callC = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
    if (callC === 0) continue;
    const propC = countP(new RegExp('\\.\\$' + n + '\\s*=', 'g'));
    if (propC > callC * 0.3) continue;
    if (countP(new RegExp('Math\\.\\$' + n + '\\(', 'g')) > 0) continue;
    if (countP(new RegExp('document\\.\\$' + n + '\\(', 'g')) > 0) continue;

    const seqOff = countP(new RegExp('\\.\\$' + n + '\\(\\w+\\+\\+', 'g'));
    const measW = countP(new RegExp('\\.\\$' + n + '\\([^)]*\\)\\.width', 'g'));
    const rectArg = countP(new RegExp('\\.\\$' + n + '\\(0,\\s*0,', 'g'));
    const fiveArg = countP(new RegExp('\\.\\$' + n + '\\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*\\)', 'g'));

    if (seqOff > callC * 0.3 && callC > 20) detected[dn] = { name: 'setUint8', scope: 'method' };
    else if (measW > 0 && callC < 20) detected[dn] = { name: 'measureText', scope: 'method' };
    else if (fiveArg > callC * 0.3 && callC < 20) detected[dn] = { name: 'roundRect', scope: 'method' };
    else if (rectArg > callC * 0.5 && callC < 30) {
        const clr = countP(new RegExp('\\.\\$' + n + '\\(0,\\s*0,\\s*\\w+\\.(?:canvas|width)', 'g'));
        detected[dn] = { name: clr > rectArg * 0.3 ? 'clearRect' : 'fillRect', scope: 'method' };
    }
}

// ── CO-OCCURRENCE TIER: canvas methods sharing primary canvas variable ──
if (lineToVar) {
    // Known canvas method signatures for identification by arg count + frequency
    // 0-arg (sorted by expected frequency): beginPath, closePath, save, restore, fill, stroke, clip
    // 2-arg: translate, scale (moveTo/lineTo already detected)
    // 3-arg: fillText, strokeText
    // 5+ arg: arc(5-6), ellipse(7-8), quadraticCurveTo(4), bezierCurveTo(6)
    // Also: drawImage(3-9), setLineDash(1), createPattern(2)
    
    const canvasCandidates = [];
    for (const dn of allDn) {
        if (detected[dn]) continue;
        const n = dn.slice(1);
        const callC = countP(new RegExp('\\.\\$' + n + '\\(', 'g'));
        const propC = countP(new RegExp('\\.\\$' + n + '\\s*=', 'g'));
        const total = callC + propC;
        if (total < 2) continue;
        const onVar = countP(new RegExp(lineToVar + '\\.\\$' + n + '[\\(\\s=]', 'g'));
        if (onVar > total * 0.75) {
            // Count args for methods
            const zeroA = countP(new RegExp('\\.\\$' + n + '\\(\\)', 'g'));
            const twoA = countP(new RegExp('\\.\\$' + n + '\\([^,)]+,\\s*[^,)]+\\)', 'g'));
            const threeA = countP(new RegExp('\\.\\$' + n + '\\([^,)]+,[^,)]+,[^,)]+\\)', 'g'));
            const fourPlusA = countP(new RegExp('\\.\\$' + n + '\\([^)]*,[^)]*,[^)]*,[^)]*', 'g'));
            canvasCandidates.push({ dn, callC, propC, total, onVar, zeroA, twoA, threeA, fourPlusA });
        }
    }
    
    // Sort by total count descending for assignment
    canvasCandidates.sort((a, b) => b.total - a.total);
    
    // Identify 0-arg canvas methods by frequency ranking
    const zeroArgCands = canvasCandidates.filter(c => c.callC > 0 && c.zeroA > c.callC * 0.5);
    zeroArgCands.sort((a, b) => b.callC - a.callC);
    const zeroArgNames = ['beginPath', 'closePath', 'save', 'restore', 'fill', 'stroke', 'clip'];
    zeroArgCands.forEach((c, i) => {
        if (i < zeroArgNames.length) detected[c.dn] = { name: zeroArgNames[i], scope: 'method' };
    });
    
    // Identify 2-arg canvas methods (translate, scale — moveTo/lineTo already done)
    const twoArgCands = canvasCandidates.filter(c => !detected[c.dn] && c.callC > 0 && c.twoA > c.callC * 0.4 && c.fourPlusA < c.callC * 0.2);
    twoArgCands.sort((a, b) => b.callC - a.callC);
    // scale typically more frequent than translate
    if (twoArgCands.length >= 2) {
        detected[twoArgCands[0].dn] = { name: 'scale', scope: 'method' };
        detected[twoArgCands[1].dn] = { name: 'translate', scope: 'method' };
        for (let i = 2; i < twoArgCands.length; i++) detected[twoArgCands[i].dn] = { name: 'rect', scope: 'method' };
    } else if (twoArgCands.length === 1) {
        detected[twoArgCands[0].dn] = { name: 'scale', scope: 'method' };
    }
    
    // Identify 4+ arg methods: arc(5-6), quadraticCurveTo(4), bezierCurveTo(6), ellipse(7-8), drawImage
    const multiArgCands = canvasCandidates.filter(c => !detected[c.dn] && c.callC > 0 && c.fourPlusA > c.callC * 0.3);
    multiArgCands.sort((a, b) => b.callC - a.callC);
    for (const c of multiArgCands) {
        const n = c.dn.slice(1);
        const sixArg = countP(new RegExp('\\.\\$' + n + '\\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*', 'g'));
        const fiveArg = countP(new RegExp('\\.\\$' + n + '\\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*\\)', 'g'));
        if (sixArg > c.callC * 0.3) {
            // 6+ args: ellipse or bezierCurveTo
            if (c.callC > 100) detected[c.dn] = { name: 'ellipse', scope: 'method' };
            else detected[c.dn] = { name: 'bezierCurveTo', scope: 'method' };
        } else if (fiveArg > c.callC * 0.3) {
            detected[c.dn] = { name: 'arc', scope: 'method' };
        } else if (c.callC < 10) {
            detected[c.dn] = { name: 'drawImage', scope: 'method' };
        } else {
            detected[c.dn] = { name: 'quadraticCurveTo', scope: 'method' };
        }
    }
    
    // Identify 3-arg methods: fillText, strokeText
    const threeArgCands = canvasCandidates.filter(c => !detected[c.dn] && c.callC > 0 && c.threeA > c.callC * 0.3 && c.fourPlusA < c.callC * 0.2);
    threeArgCands.sort((a, b) => b.callC - a.callC);
    const threeArgNames = ['fillText', 'strokeText'];
    threeArgCands.forEach((c, i) => {
        if (i < threeArgNames.length) detected[c.dn] = { name: threeArgNames[i], scope: 'method' };
    });
    
    // Canvas properties on primary var: lineWidth, strokeStyle, fillStyle, globalAlpha, etc.
    const propCands = canvasCandidates.filter(c => !detected[c.dn] && c.propC > 0 && c.callC === 0);
    for (const c of propCands) {
        const n = c.dn.slice(1);
        const colorV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*(?:this\\.As\\(|"(?:rgba|hsla|#))', 'g'));
        const decV = countP(new RegExp('\\.\\$' + n + '\\s*=\\s*0?\\.\\d', 'g'));
        if (colorV > c.propC * 0.2 && c.propC > 100) detected[c.dn] = { name: 'strokeStyle', scope: 'prop' };
        else if (colorV > c.propC * 0.2) detected[c.dn] = { name: 'shadowColor', scope: 'prop' };
        else if (decV > c.propC * 0.15) detected[c.dn] = { name: 'globalAlpha', scope: 'prop' };
    }
    
    // Remaining unresolved with high canvas co-occurrence: likely canvas methods we couldn't identify
    // Leave as-is rather than guess wrong
}

// ── APPLY MAPPINGS ──
console.log('  Auto-detected ' + Object.keys(detected).length + ' mappings:');
const sorted = Object.entries(detected).sort((a, b) => parseInt(a[0].slice(1)) - parseInt(b[0].slice(1)));
for (const [dn, info] of sorted) console.log('    ' + dn + ' → ' + info.name);

for (const [dn, info] of Object.entries(detected)) {
    const n = dn.slice(1);
    if (info.scope === 'Math') {
        code = code.replace(new RegExp('Math\\.\\$' + n + '\\(', 'g'), 'Math.' + info.name + '(');
    } else if (info.scope === 'document') {
        code = code.replace(new RegExp('document\\.\\$' + n + '\\(', 'g'), 'document.' + info.name + '(');
    } else if (info.scope === 'prop') {
        code = code.replace(new RegExp('\\.\\$' + n + '\\b', 'g'), '.' + info.name);
    } else {
        code = code.replace(new RegExp('\\.\\$' + n + '\\(', 'g'), '.' + info.name + '(');
    }
}

// Bracket-to-dot notation
code = code.replace(/(\w|\)|\])\["([a-zA-Z_$][a-zA-Z0-9_$]*)"\]/g, '$1.$2');
code = code.replace(/\["([a-zA-Z_$][a-zA-Z0-9_$]*)"\]\s*:/g, '$1:');
console.log('  Normalization applied.');


// ========================================================================
// PHASE 7: Write output
// ========================================================================
fs.writeFileSync('zorr-deobfuscated.js', code, 'utf8');
console.log('\n=== Complete ===');
console.log('Output: zorr-deobfuscated.js');
console.log('Size:', code.length, 'bytes');
console.log('Lines:', code.split('\n').length);

// Quick audit
const remaining_dollar = (code.match(/\.\$\d+/g) || []).length;
const remaining_es = (code.match(/\.es\(/g) || []).length;
console.log('Remaining .$N patterns:', remaining_dollar);
console.log('Remaining .es() calls:', remaining_es);
