#!/usr/bin/env node
// PEEL komut satırı: tarayıcıdakiyle aynı motor, aynı QuickJS sandbox.
// Kullanım: peel <girdi.js> [-o çıktı.js] [--report rapor.json] [--vm-out klasör] [--jsvmp] [--quiet]
//           peel asm <prog.asm> --isa <vmN.json> [-o bytecode.json]
//           peel vm-compare <a.js> <b.js>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { deobfuscate } from '../src/core/pipeline.js';
import { analyze } from '../src/core/analyze.js';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { vmReport, isaFromFinding, encoderFor } from '../src/core/vm/report.js';
import { assemble, compareSignatures } from '../src/core/vm/semantics.js';

const HELP = `PEEL: obfuscated JavaScript deobfuscator

Usage:
  peel <input.js> [-o output.js] [--report report.json] [--vm-out dir] [--jsvmp] [--quiet]
  peel asm <program.asm> --isa <vmN.json> [-o bytecode.json]
  peel vm-compare <a.js> <b.js>
  cat input.js | peel - > output.js

Options:
  -o, --out <file>      write deobfuscated code to file (default: stdout)
  -r, --report <file>   write analysis report (JSON)
  --vm-out <dir>        write each bytecode VM's bytecode, ISA, assembly, IR and lifted code to <dir>
  --jsvmp               jsvmp mode: only VM-related passes, print a VM summary on stderr
  -q, --quiet           no log output on stderr
  -h, --help            show this help`;

// jsvmp modu (E198): yalnızca VM'e yönelik pass'ler; çıktı ve VM özeti
const JSVMP_PASSES = ['normalize', 'unpack', 'literals', 'const-arrays', 'const-objects', 'const-fold', 'state-var', 'vm-lift',
  'unflatten', 'vm', 'anti-timing', 'dead-code', 'simplify', 'unused'];

function parseArgs(argv) {
  const opts = { cmd: 'peel', input: null, inputs: [], out: null, report: null, vmOut: null, isa: null, jsvmp: false, quiet: false };
  if (argv[0] === 'asm' || argv[0] === 'vm-compare') opts.cmd = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '-r' || a === '--report') opts.report = argv[++i];
    else if (a === '--vm-out') opts.vmOut = argv[++i];
    else if (a === '--isa') opts.isa = argv[++i];
    else if (a === '--jsvmp') opts.jsvmp = true;
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (!a.startsWith('-') || a === '-') opts.inputs.push(a);
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  opts.input = opts.inputs[0] ?? null;
  if (!opts.input || (opts.cmd === 'vm-compare' && opts.inputs.length < 2) || (opts.cmd === 'asm' && !opts.isa)) { console.error(HELP); process.exit(2); }
  return opts;
}

function read(file) {
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    process.exit(1);
  }
}

const opts = parseArgs(process.argv.slice(2));
const log = (m, lv) => { if (!opts.quiet) console.error(`[${lv}] ${m}`); };

// Assembler (E194/E658): disassembly ile aynı ISA'dan bytecode üret
if (opts.cmd === 'asm') {
  const vm = JSON.parse(read(opts.isa));
  const r = assemble(read(opts.input), isaFromFinding(vm), encoderFor(vm));
  if (r.errors.length) { console.error(r.errors.join('\n')); process.exit(1); }
  const text = JSON.stringify({ kind: typeof r.code === 'string' ? 'string' : 'array', bytecode: r.code });
  if (opts.out) writeFileSync(opts.out, text); else process.stdout.write(`${text}\n`);
  process.exit(0);
}

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));

async function peel(input) {
  return deobfuscate(input, { level: 4, sandbox, deep: true, onLog: log, only: opts.jsvmp ? JSVMP_PASSES : null });
}

// VM sürüm eşleştirme (madde 37, E656): iki dosyadaki bytecode VM imzalarını karşılaştır
if (opts.cmd === 'vm-compare') {
  const [a, b] = await Promise.all(opts.inputs.slice(0, 2).map(async (f) => vmReport((await peel(read(f))).findings)));
  if (!a?.bytecode.length || !b?.bytecode.length) { console.error('Bytecode VM bulunamadı'); process.exit(1); }
  const out = [];
  for (const [i, x] of a.bytecode.entries()) {
    for (const [j, y] of b.bytecode.entries()) out.push({ a: i, b: j, ...compareSignatures(x.signature, y.signature) });
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

const input = read(opts.input);
const t0 = performance.now();
const result = await peel(input);
if (result.error) {
  console.error(`Parse error: ${result.error}`);
  process.exit(1);
}
if (!result.verified) console.error('[warn] behaviour could not be verified in the sandbox; review the output');
if (opts.out) writeFileSync(opts.out, result.code);
else process.stdout.write(result.code);

const vm = vmReport(result.findings);
// Bytecode'u ayrı dosyalara çıkar (E193)
if (opts.vmOut && vm) {
  mkdirSync(opts.vmOut, { recursive: true });
  vm.bytecode.forEach((f, i) => {
    const base = join(opts.vmOut, `vm${i}`);
    writeFileSync(`${base}.json`, JSON.stringify({
      kind: f.codeKind, bytecode: f.bytecode, consts: f.constPool?.map((c) => c.value) ?? [], isa: f.isa, opcodeMap: f.opcodeMap,
      disasm: f.disasm?.map((x) => ({ op: x.op, operands: x.operands })), signature: f.signature,
    }, null, 1));
    if (f.assembly) writeFileSync(`${base}.asm`, f.assembly);
    if (f.ir) writeFileSync(`${base}-ir.txt`, f.ir.map((x) => `${x.pc} ${x.mnemonic}\n${x.lines.map((l) => `  ${l}`).join('\n')}`).join('\n'));
    if (f.liftedCode) writeFileSync(`${base}-lifted.js`, f.liftedCode);
    if (f.rawSource) writeFileSync(`${base}-raw.js`, f.rawSource);
    if (f.readable) writeFileSync(`${base}-readable.js`, f.readable);
  });
  log(`${vm.bytecode.length} VM ${opts.vmOut} klasörüne yazıldı`, 'ok');
}
if (opts.jsvmp && vm) {
  for (const [i, f] of vm.bytecode.entries()) {
    console.error(`\n== VM #${i} (${f.style}, ${f.disasm?.length ?? '?'} komut, ${f.lifted ? 'çevrildi' : `çevrilemedi: ${f.reason}`})`);
    for (const h of f.handlers) console.error(`  ${String(h.key).padStart(4)}  ${(h.staticName ?? '?').padEnd(12)} ${h.semantics}`);
    if (f.listing) console.error(f.listing);
  }
}

if (opts.report) {
  const report = await analyze({ input, text: result.text, output: result.code, events: result.events, sandbox, findings: result.findings });
  writeFileSync(opts.report, JSON.stringify({ stats: result.stats, ...report }, null, 2));
}
log(`done in ${((performance.now() - t0) / 1000).toFixed(2)}s`, 'ok');
