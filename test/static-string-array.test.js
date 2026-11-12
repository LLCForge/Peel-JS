// obfuscator.io string dizisinin sandbox'sız sembolik çözümü (E38/E93): node test/static-string-array.test.js
import assert from 'node:assert/strict';
import vm from 'node:vm';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { deobfuscate } from '../src/core/pipeline.js';

const SRC = 'function greet(n){return "Hello, "+n+"!";} var config={endpoint:"https://api.example.com/v1/collect",retries:3}; console.log(greet("PEEL"), config.endpoint, ["alpha","beta"].join("-"));';
const run = (code) => {
  const out = [];
  vm.runInNewContext(code, { console: { log: (...a) => out.push(a.join(' ')) } }, { timeout: 2000 });
  return out.join('\n');
};
const expected = run(SRC);

const CASES = {
  none: { stringArrayThreshold: 1, stringArrayRotate: true, stringArrayShuffle: true },
  base64: { stringArrayThreshold: 1, stringArrayEncoding: ['base64'], stringArrayRotate: true },
  // RC4: anahtar ayrı sarmalayıcı fonksiyonun parametresinden gelir (E93)
  rc4: { stringArrayThreshold: 1, stringArrayEncoding: ['rc4'], stringArrayWrappersCount: 2, stringArrayWrappersType: 'function', stringArrayWrappersChainedCalls: true },
  shift: { stringArrayThreshold: 1, stringArrayIndexShift: true, stringArrayWrappersCount: 3, stringArrayWrappersType: 'function', stringArrayWrappersParametersMaxCount: 5 },
  variable: { stringArrayThreshold: 1, stringArrayEncoding: ['base64'], stringArrayWrappersCount: 2, stringArrayWrappersType: 'variable' },
};

for (const [name, opts] of Object.entries(CASES)) {
  for (let seed = 1; seed <= 3; seed++) {
    const obf = JavaScriptObfuscator.obfuscate(SRC, { ...opts, seed }).getObfuscatedCode();
    // sandbox yok: yalnızca statik pass'ler
    const r = await deobfuscate(obf, { level: 4, sandbox: null });
    assert.ok(!r.error, `${name}/${seed}: ${r.error}`);
    for (const s of ['"Hello, "', '"https://api.example.com/v1/collect"', '"alpha']) assert.ok(r.code.includes(s), `${name}/${seed}: ${s} yok\n${r.code}`);
    // altyapı kalmamalı: string dizisi literal'i silinmiş olmalı
    assert.ok(!/\[\s*"[^"]*",\s*"[^"]*",\s*"[^"]*",/.test(r.code), `${name}/${seed}: dizi kaldı\n${r.code}`);
    assert.equal(run(r.code), expected, `${name}/${seed}: davranış`);
    assert.ok((r.stats.staticStringArray ?? 0) > 0, `${name}/${seed}: pass çalışmadı`);
  }
}
console.log('static-string-array: ok');
