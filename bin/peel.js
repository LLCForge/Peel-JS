#!/usr/bin/env node
// PEEL komut satırı: tarayıcıdakiyle aynı motor, aynı QuickJS sandbox.
// Kullanım: peel <girdi.js> [-o çıktı.js] [--report rapor.json] [--quiet]
import { readFileSync, writeFileSync } from 'node:fs';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { analyze } from '../src/core/analyze.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { parseNameMap } from '../src/naming/names.js';
import { toDts } from '../src/naming/types.js';
import { parse } from '../src/core/parse.js';
import { FORMAT_PROFILES } from '../src/core/emit.js';

const HELP = `PEEL: obfuscated JavaScript deobfuscator

Usage:
  peel <input.js> [-o output.js] [--report report.json] [--quiet]
  cat input.js | peel - > output.js

Options:
  -o, --out <file>      write deobfuscated code to file (default: stdout)
  -r, --report <file>   write analysis report (JSON)
  -q, --quiet           no log output on stderr
  -n, --names <file>    apply a shared name map (JSON: {"old": "new"} or PEEL name map)
  -f, --format <name>   output format profile: ${Object.keys(FORMAT_PROFILES).join(', ')}
  --dts <file>          write inferred TypeScript declarations (.d.ts)
  -h, --help            show this help`;

function parseArgs(argv) {
  const opts = { input: null, out: null, report: null, quiet: false, names: null, format: 'default', dts: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '-r' || a === '--report') opts.report = argv[++i];
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '-n' || a === '--names') opts.names = argv[++i];
    else if (a === '-f' || a === '--format') opts.format = argv[++i];
    else if (a === '--dts') opts.dts = argv[++i];
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

if (!Object.hasOwn(FORMAT_PROFILES, opts.format)) {
  console.error(`Unknown format profile: ${opts.format}`);
  process.exit(2);
}
let names = {};
if (opts.names) {
  let text;
  try { text = readFileSync(opts.names, 'utf8'); } catch (e) { console.error(`Cannot read name map: ${e.message}`); process.exit(1); }
  const r = parseNameMap(text);
  if (!r.ok) { console.error(`Invalid name map: ${r.error}`); process.exit(1); }
  names = r.names;
}

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const log = (m, lv) => { if (!opts.quiet) console.error(`[${lv}] ${m}`); };

const t0 = performance.now();
const result = await deobfuscate(input, { level: 4, sandbox, deep: true, onLog: log, naming: { names }, format: opts.format });
if (result.error) {
  console.error(`Parse error: ${result.error}`);
  process.exit(1);
}
if (!result.verified) console.error('[warn] behaviour could not be verified in the sandbox; review the output');
if (opts.out) writeFileSync(opts.out, result.code);
else process.stdout.write(result.code);

if (opts.dts) writeFileSync(opts.dts, toDts(parse(result.code)));

if (opts.report) {
  const report = await analyze({ input, text: result.text, output: result.code, events: result.events, sandbox });
  writeFileSync(opts.report, JSON.stringify({ stats: result.stats, ...report }, null, 2));
}
log(`done in ${((performance.now() - t0) / 1000).toFixed(2)}s`, 'ok');
