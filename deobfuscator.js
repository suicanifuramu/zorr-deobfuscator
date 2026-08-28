/**
 * Zorr Deobfuscator v2 — importable module.
 *
 * deobfuscate(webcrackedCode: string) → { code, stats }
 * Dynamically extracts and executes the decoder from the source itself.
 * No external JSON data files required.
 */
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const bt = require('@babel/types');
const vm = require('vm');

function deobfuscate(sourceCode) {
console.log('=== Zorr Deobfuscator v2 ===');

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


// PHASE 6 — resolve .$N mangled members using the ground-truth mapping extracted at runtime.
// The obfuscator renames built-in methods (Math.*, canvas ctx.*, document.*, DataView.*) to $N
// and restores them at runtime via JSON mapping tables. The mapping below was captured by
// executing the game's own runtime un-mangling code (u + w tables).
console.log('Phase 6: Resolving .$N property mangles from ground-truth mapping...');

const MANGLE_MAP = {
    // Math
    floor: '$6', random: '$7', round: '$8', pow: '$9', ceil: '$10',
    min: '$11', abs: '$12', cos: '$13', sin: '$14', exp: '$15',
    hypot: '$16', acos: '$17', max: '$18', sign: '$52', log2: '$59',
    atan2: '$69', sqrt: '$82',
    // CanvasRenderingContext2D methods
    lineTo: '$19', moveTo: '$20', ellipse: '$21', quadraticCurveTo: '$22',
    bezierCurveTo: '$23', closePath: '$24', arc: '$25', save: '$26',
    rotate: '$27', beginPath: '$28', fill: '$30', clip: '$31',
    stroke: '$36', restore: '$37', scale: '$38', translate: '$40',
    rect: '$41', strokeText: '$45', fillText: '$46', setLineDash: '$49',
    strokeRect: '$51', createPattern: '$60', fillRect: '$65', clearRect: '$66',
    roundRect: '$70', measureText: '$71', drawImage: '$72', setTransform: '$77',
    createImageData: '$83', putImageData: '$84',
    // document
    createElement: '$5', querySelectorAll: '$61', querySelector: '$62',
    exitFullscreen: '$63', getElementById: '$64', elementFromPoint: '$67',
    // DataView
    setUint32: '$53', setUint8: '$54', getUint32: '$55', setUint16: '$56',
    getUint16: '$57', getUint8: '$58', setFloat32: '$73', getTransform: '$75',
    getBigUint64: '$80', getFloat32: '$81',
    // misc
    addEventListener: '$68', removeEventListener: '$85',
};

// Canvas/document *properties* (resolved via runtime accessor patching, not in the method map).
// Distinguished from methods by usage: assigned (ctx.$29 = x) vs called.
const PROP_MAP = {
    $29: 'strokeStyle', $32: 'lineJoin', $33: 'lineCap', $34: 'lineWidth',
    $35: 'shadowColor', $39: 'globalAlpha', $42: 'textBaseline', $43: 'font',
    $44: 'textAlign', $47: 'shadowBlur', $48: 'strokeStyle', $50: 'globalCompositeOperation',
    $74: 'shadowOffsetX', $76: 'shadowOffsetY', $78: 'imageSmoothingEnabled',
    $79: 'shadowOffsetX', $27: 'rotate', $39: 'globalAlpha',
};

// Build reverse lookup: $N → real name
const reverse = {};
for (const [name, dn] of Object.entries(MANGLE_MAP)) reverse[dn] = name;
for (const [dn, name] of Object.entries(PROP_MAP)) reverse[dn] = name;

let code = generate(ast, { retainLines: false, compact: false }).code;

const allDn = new Set();
{ let m; const re = /\.(\$\d+)/g; while (m = re.exec(code)) allDn.add(m[1]); }
console.log('  Found ' + allDn.size + ' unique .$N patterns.');

let resolvedCount = 0;
const unresolved = [];
for (const dn of allDn) {
    if (reverse[dn]) {
        code = code.replace(new RegExp('\\.' + dn.replace('$', '\\$') + '(?!\\d)', 'g'), '.' + reverse[dn]);
        resolvedCount++;
    } else {
        unresolved.push(dn);
    }
}
if (unresolved.length) console.log('  Unresolved .$N: ' + unresolved.join(', '));
console.log('  Resolved ' + resolvedCount + '/' + allDn.size + ' mappings.');

// Bracket-to-dot notation
code = code.replace(/(\w|\)|\])\["([a-zA-Z_$][a-zA-Z0-9_$]*)"\]/g, '$1.$2');
code = code.replace(/\["([a-zA-Z_$][a-zA-Z0-9_$]*)"\]\s*:/g, '$1:');
console.log('  Normalization applied.');



// ========================================================================
// Return result
// ========================================================================
const stats = {
    size: code.length,
    lines: code.split('\n').length,
    remainingDollar: (code.match(/\.\$\d+/g) || []).length,
    remainingEs: (code.match(/\.es\(/g) || []).length,
};
console.log('\n=== Complete ===');
console.log('Size:', stats.size, 'bytes');
console.log('Lines:', stats.lines);
console.log('Remaining .$N patterns:', stats.remainingDollar);
console.log('Remaining .es() calls:', stats.remainingEs);

return { code, stats };
}

module.exports = { deobfuscate };
