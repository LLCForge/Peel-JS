// Gerçek obfuscator.io (javascript-obfuscator) ve js-confuser çıktılarıyla PEEL benchmark'ı.
// Kullanım: node bench.mjs [filtre]
import { mkdirSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import JavaScriptObfuscator from 'javascript-obfuscator';
import JsConfuser from 'js-confuser';

// Gerçek obfuscator çıktıları üzerinde uçtan uca ölçüm. Kullanım: npm run bench [filtre]
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';

const SOURCE = `
function greet(name) { return "Hello, " + name + "!"; }
var config = { endpoint: "https://api.example.com/v1/collect", retries: 3, debug: false };
function sum(list) { var s = 0; for (var i = 0; i < list.length; i++) s += list[i]; return s; }
class Counter { constructor() { this.n = 0; } inc() { this.n++; return this.n; } }
var c = new Counter(); c.inc(); c.inc();
var words = ["alpha", "beta", "gamma"].map(function (w) { return w.toUpperCase(); });
console.log(greet("PEEL"));
console.log(config.endpoint, config.retries * 2, sum([1, 2, 3, 4]));
console.log(words.join("-"), c.n, typeof config.debug);
if (config.debug) { console.log("debug mode"); } else { console.log("production"); }
`;
const NEEDLES = ['"Hello, "', '"https://api.example.com/v1/collect"', '"alpha"', '"production"', 'toUpperCase', '.join(', 'console.log'];

const OBF_IO = {
  'io-default': {},
  'io-base64': { stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 1 },
  'io-rc4': { stringArray: true, stringArrayEncoding: ['rc4'], stringArrayThreshold: 1 },
  'io-wrappers': { stringArray: true, stringArrayThreshold: 1, rotateStringArray: true, shuffleStringArray: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', stringArrayWrappersChainedCalls: true, stringArrayIndexShift: true },
  'io-cff': { controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, stringArrayThreshold: 1 },
  'io-deadcode': { deadCodeInjection: true, deadCodeInjectionThreshold: 1, stringArrayThreshold: 1 },
  'io-protect': { selfDefending: true, debugProtection: true, disableConsoleOutput: false },
  'io-objkeys': { transformObjectKeys: true, stringArrayThreshold: 1 },
  'io-numbers': { numbersToExpressions: true, simplify: true },
  'io-split': { splitStrings: true, splitStringsChunkLength: 3, stringArrayThreshold: 1 },
  'io-unicode': { unicodeEscapeSequence: true, stringArrayThreshold: 1 },
  'io-high': { compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 1, numbersToExpressions: true, simplify: true, splitStrings: true, splitStringsChunkLength: 5, stringArray: true, stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 1, stringArrayEncoding: ['rc4'], stringArrayIndexShift: true, stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 5, stringArrayWrappersChainedCalls: true, stringArrayWrappersParametersMaxCount: 5, stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true },
};
const CONFUSER = {
  'jc-low': { target: 'browser', preset: 'low' },
  'jc-medium': { target: 'browser', preset: 'medium' },
  'jc-high': { target: 'browser', preset: 'high' },
  'jc-strings': { target: 'browser', stringConcealing: true, stringEncoding: true, stringSplitting: true },
  'jc-flatten': { target: 'browser', flatten: true, dispatcher: true },
  'jc-cff': { target: 'browser', controlFlowFlattening: true },
  'jc-globals': { target: 'browser', globalConcealing: true, renameVariables: true },
  'jc-calc': { target: 'browser', calculator: true, duplicateLiteralsRemoval: true, objectExtraction: true },
  'jc-opaque': { target: 'browser', opaquePredicates: true, deadCode: true },
  'jc-moved': { target: 'browser', movedDeclarations: true },
};

function runNode(code) {
  const out = [];
  const ctx = { console: { log: (...a) => out.push(a.map(String).join(' ')) } };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  try { vm.runInNewContext(code, ctx, { timeout: 3000 }); } catch (e) { out.push(`!THROW ${e.message}`); }
  return out.join('\n');
}

const filter = process.argv[2];
const outDir = new URL('./bench-out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const expected = runNode(SOURCE);
const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));

const rows = [];
async function bench(name, obfuscated) {
  writeFileSync(new URL(`${name}.in.js`, outDir), obfuscated);
  const t0 = performance.now();
  const logs = [];
  let r;
  try {
    r = await deobfuscate(obfuscated, { level: 4, sandbox, deep: true, onLog: (m, lv) => logs.push(`[${lv}] ${m}`) });
  } catch (e) {
    rows.push({ name, ok: false, why: e.message });
    return;
  }
  writeFileSync(new URL(`${name}.out.js`, outDir), r.code);
  writeFileSync(new URL(`${name}.log`, outDir), logs.join('\n'));
  const same = runNode(r.code) === expected;
  const found = NEEDLES.filter((n) => r.code.includes(n)).length;
  rows.push({
    name, same, score: `${found}/${NEEDLES.length}`, inKB: (obfuscated.length / 1024).toFixed(1),
    outKB: (r.code.length / 1024).toFixed(1), ms: Math.round(performance.now() - t0),
    rollbacks: logs.filter((l) => l.includes('geri alındı')).length,
  });
}

for (const [name, opts] of Object.entries(OBF_IO)) {
  if (filter && !name.includes(filter)) continue;
  const code = JavaScriptObfuscator.obfuscate(SOURCE, { seed: 42, target: 'browser', ...opts }).getObfuscatedCode();
  await bench(name, code);
}
for (const [name, opts] of Object.entries(CONFUSER)) {
  if (filter && !name.includes(filter)) continue;
  const res = await JsConfuser.obfuscate(SOURCE, opts);
  await bench(name, typeof res === 'string' ? res : res.code);
}
console.table(rows);
