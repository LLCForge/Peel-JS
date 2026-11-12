#!/usr/bin/env node
// PEEL komut satırı: tarayıcıdakiyle aynı motor, aynı QuickJS sandbox.
// Kullanım: peel <girdi.js> [-o çıktı.js] [--report rapor.json] [--quiet] [--source-map harita.map] [--split klasör]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { analyze } from '../src/core/analyze.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { splitBundle } from '../src/core/bundle.js';

const HELP = `PEEL: obfuscated JavaScript deobfuscator

Usage:
  peel <input.js> [-o output.js] [--report report.json] [--quiet]
  cat input.js | peel - > output.js

Options:
  -o, --out <file>      write deobfuscated code to file (default: stdout)
  -r, --report <file>   write analysis report (JSON)
  -q, --quiet           no log output on stderr
  -m, --source-map <f>  recover names from a source map file (partial maps are fine)
  -s, --split <dir>     write the modules of a webpack/esbuild/browserify/source-mapped bundle to <dir>
  -h, --help            show this help`;

function parseArgs(argv) {
  const opts = { input: null, out: null, report: null, quiet: false, sourceMap: null, split: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '-r' || a === '--report') opts.report = argv[++i];
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '-m' || a === '--source-map') opts.sourceMap = argv[++i];
    else if (a === '-s' || a === '--split') opts.split = argv[++i];
    else if (!opts.input) opts.input = a;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  if (!opts.input) { console.error(HELP); process.exit(2); }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let input;
try {
  input = readFileSync(opts.input === '-' ? 0 : opts.input, 'utf8');
} catch (e) {
  console.error(`Cannot read input: ${e.message}`);
  process.exit(1);
}

// A-25: harita dosyası satır içi haritaya çevrilir; sourcemap pass'i aynı yoldan okur
if (opts.sourceMap) {
  try {
    const map = readFileSync(opts.sourceMap, 'utf8');
    input = `${input.replace(/\n\/\/[#@]\s*sourceMappingURL=.*\s*$/, '')}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n`;
  } catch (e) {
    console.error(`Cannot read source map: ${e.message}`);
    process.exit(1);
  }
}

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const log = (m, lv) => { if (!opts.quiet) console.error(`[${lv}] ${m}`); };

const t0 = performance.now();
const result = await deobfuscate(input, { level: 4, sandbox, deep: true, onLog: log });
if (result.error) {
  console.error(`Parse error: ${result.error}`);
  process.exit(1);
}
if (!result.verified) console.error('[warn] behaviour could not be verified in the sandbox; review the output');
if (opts.out) writeFileSync(opts.out, result.code);
else process.stdout.write(result.code);

if (opts.report) {
  const report = await analyze({ input, text: result.text, output: result.code, events: result.events, sandbox, stats: result.stats });
  writeFileSync(opts.report, JSON.stringify({ stats: result.stats, ...report }, null, 2));
}
// A-24: paket modüllerini ayrı dosyalara yaz (önce çözülmüş çıktı, olmazsa haritalı girdi)
if (opts.split) {
  const bundle = splitBundle(result.code, { map: false }) ?? splitBundle(result.text ?? input);
  if (!bundle) {
    console.error('[warn] no bundle structure found; nothing split');
  } else {
    mkdirSync(opts.split, { recursive: true });
    const used = new Set();
    for (const m of bundle.modules) {
      let name = m.id.replace(/^[./\\]+/, '').replace(/[^\w.@-]+/g, '_').slice(0, 120) || 'module';
      if (!/\.[cm]?[jt]sx?$/.test(name)) name += '.js';
      while (used.has(name)) name = `_${name}`;
      used.add(name);
      writeFileSync(join(opts.split, name), `// ${bundle.kind} module ${m.id}${m.deps.length ? ` — deps: ${m.deps.join(', ')}` : ''}\n${m.code}\n`);
    }
    log(`${bundle.modules.length} ${bundle.kind} modules written to ${opts.split}`, 'info');
  }
}
log(`done in ${((performance.now() - t0) / 1000).toFixed(2)}s`, 'ok');
