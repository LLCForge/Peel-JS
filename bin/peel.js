#!/usr/bin/env node
// PEEL komut satırı: tarayıcıdakiyle aynı motor, aynı QuickJS sandbox.
// Kullanım: peel <girdi.js> [-o çıktı.js] [--report rapor.json] [--quiet]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { analyze } from '../src/core/analyze.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { detectTools, autoProfile, PROFILES } from '../src/core/detect.js';
import { searchPassOrder, cascade } from '../src/core/search.js';
import { incidentReport } from '../src/security/incident.js';
import { generateSourceMap } from '../src/core/sourcemap.js';

const HELP = `PEEL: obfuscated JavaScript deobfuscator

Usage:
  peel <input.js> [-o output.js] [--report report.json] [--quiet]
  cat input.js | peel - > output.js

Options:
  -o, --out <file>      write deobfuscated code to file (default: stdout)
  -r, --report <file>   write analysis report (JSON)
  -q, --quiet           no log output on stderr
  -p, --profile <name>  pass profile: all (default), auto (detected tool above score threshold) or a profile name
      --order-search    try several pass orders and keep the best verified result
      --cascade         run levels 1→4 in stages, each on the previous verified output
      --incident <file> write an incident response report (Markdown; JSON next to it)
      --source-map <f>  write a source map from the output back to the input
  -h, --help            show this help`;

function parseArgs(argv) {
  const opts = { input: null, out: null, report: null, quiet: false, profile: 'all', orderSearch: false, cascade: false, incident: null, sourceMap: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '-r' || a === '--report') opts.report = argv[++i];
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '-p' || a === '--profile') opts.profile = argv[++i];
    else if (a === '--order-search') opts.orderSearch = true;
    else if (a === '--cascade') opts.cascade = true;
    else if (a === '--incident') opts.incident = argv[++i];
    else if (a === '--source-map') opts.sourceMap = argv[++i];
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

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const log = (m, lv) => { if (!opts.quiet) console.error(`[${lv}] ${m}`); };

const t0 = performance.now();
// E26: pass profili — auto: eşiği aşan araç tespitine göre, aksi halde tüm pass'ler (bilinmeyen araç modu)
let only = null;
if (opts.profile === 'auto') {
  const p = autoProfile(detectTools(input));
  only = p.passes;
  log(`profile: ${p.profile} (${p.reason})`, 'info');
} else if (opts.profile !== 'all') {
  if (!Object.hasOwn(PROFILES, opts.profile)) { console.error(`Unknown profile: ${opts.profile} (${Object.keys(PROFILES).join(', ')}, auto)`); process.exit(2); }
  only = PROFILES[opts.profile];
}
let result = await deobfuscate(input, { level: 4, only, sandbox, deep: true, onLog: log });
// E32 / E33: daha iyi doğrulanmış sonuç bulunursa çıktı onunla değiştirilir (rapor/harita yine ilk çalıştırmanın metin katmanını kullanır)
if (!result.error && opts.orderSearch) {
  const s = await searchPassOrder(input, { sandbox, onLog: log });
  if (s.best) { log(`order search: ${s.best.name} (score ${s.best.score})`, 'ok'); result = { ...result, code: s.best.code, verified: s.best.verified }; }
}
if (!result.error && opts.cascade) {
  const c = await cascade(input, { sandbox, onLog: log });
  log(`cascade: score ${c.score}`, 'ok');
  result = { ...result, code: c.code };
}
if (result.error) {
  console.error(`Parse error: ${result.error}`);
  process.exit(1);
}
if (!result.verified) console.error('[warn] behaviour could not be verified in the sandbox; review the output');
if (opts.out) writeFileSync(opts.out, result.code);
else process.stdout.write(result.code);

if (opts.report || opts.incident) {
  const report = await analyze({ input, text: result.text, output: result.code, events: result.events, sandbox, verified: result.verified });
  // BigInt ve fonksiyon alanları JSON'a yazılmaz
  const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : typeof x === 'function' ? undefined : x), 2);
  if (opts.report) writeFileSync(opts.report, json({ stats: result.stats, ...report }));
  if (opts.incident) {
    const inc = await incidentReport({ report, input, output: result.code, meta: { title: basename(opts.input), source: basename(opts.input) } });
    writeFileSync(opts.incident, inc.markdown);
    writeFileSync(opts.incident.replace(/\.md$/i, '') + '.json', inc.json);
  }
}
if (opts.sourceMap) {
  const sm = generateSourceMap(result.text, result.code, { file: opts.out ?? 'peeled.js', source: opts.input === '-' ? 'stdin.js' : opts.input });
  writeFileSync(opts.sourceMap, JSON.stringify(sm.map));
  log(`source map: ${sm.matched} tokens, coverage ${Math.round(sm.coverage * 100)}%`, 'info');
}
log(`done in ${((performance.now() - t0) / 1000).toFixed(2)}s`, 'ok');
