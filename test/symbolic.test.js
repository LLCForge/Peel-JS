// Sembolik motor öz-denetimi: node test/symbolic.test.js
import assert from 'node:assert/strict';
import { explore, synthesizeInputs, boundedCheck, divergingInput, proveEquivalent } from '../src/verify/symbolic/api.js';

const TWO_IFS = 'function f(a, b) { let r = 0; if (a > 0) r = 1; else r = 2; if (b > 0) r += 10; return r; }';

// E735/E736: birleştirme açıkken tek yol, kapalıyken 4 yol
const merged = explore(TWO_IFS);
assert.equal(merged.status, 'ok');
assert.equal(merged.forks, 2);
assert.equal(merged.merges, 2);
assert.equal(merged.paths.length, 1);
assert.equal(merged.paths[0].pc, 'true');
const forked = explore(TWO_IFS, { merge: false });
assert.equal(forked.paths.length, 4);
assert.equal(forked.merges, 0);

// E733: yalnızca b sembolik, a somut → tek çatallanma
const inj = explore(TWO_IFS, { symbolic: ['b'], concrete: { a: 5 }, merge: false });
assert.equal(inj.forks, 1);
assert.deepEqual(inj.inputs, ['arg1']);
const glob = explore('function f(x) { return x + LIMIT; }', { globals: { LIMIT: 'symbolic' } });
assert.deepEqual(glob.inputs, ['arg0', 'g_LIMIT']);

// E737: sınırlayıcı
const many = 'function f(a, b, c, d) { let r = 0; if (a) r++; if (b) r++; if (c) r++; if (d) r++; return r; }';
const lim = explore(many, { merge: false, maxPaths: 5 });
assert.match(lim.limited, /yol sınırı/);
assert.ok(lim.paths.some((p) => p.kind === 'limit'));
assert.match(explore(many, { merge: false, maxDepth: 2 }).limited, /derinlik/);
assert.equal(explore(many).limited, null);

// E734: budama, artımlı depo önbelleği
const pr = explore('function f(x) { if (x > 5) { if (x < 3) return 1; return 2; } return 3; }', { merge: false, prune: true });
assert.equal(pr.pruned, 1);
assert.equal(pr.paths.length, 2);
assert.ok(pr.store.queries >= 2);

// E702: BMC — sınır içinde özellik tutuyor ama tam değil; ihlal bulunuyor
const sum = 'function s(n) { let t = 0; for (let i = 0; i < n; i++) t += i; return t; }';
const ok = await boundedCheck(sum, 'result >= 0', { bound: 4 });
assert.equal(ok.status, 'holds');
assert.equal(ok.complete, false);
const bad = await boundedCheck(sum, 'result < 5', { bound: 4 });
assert.equal(bad.status, 'violated');
assert.ok(bad.minimized[0] >= 4 && bad.result.value >= 5);
const full = await boundedCheck('function g(n) { let k = 0; while (k < 3) k++; return k + n * 0; }', 'result === 3', { bound: 5 });
assert.equal(full.status, 'holds');
assert.equal(full.complete, true);

// E739: sentezlenen girdiler somut çalıştırmada her dalı kapsar
const src = 'function f(a, b) { if (a > 5) { if (b === a * 2) return 1; return 2; } return 3; }';
const syn = synthesizeInputs(src);
const fn = (a, b) => { if (a > 5) { if (b === a * 2) return 1; return 2; } return 3; };
assert.deepEqual(new Set(syn.inputs.map(([a, b]) => fn(a, b))), new Set([1, 2, 3]));

// E703: ayrışan girdi ve yol koşulları
const div = await divergingInput('function f(x) { if (x > 10) return x - 1; return x; }', 'function g(x) { return x; }');
assert.equal(div.found, true);
assert.deepEqual(div.input, [11]);
assert.match(div.pathA, /10 < sext32\(arg0\)/);
assert.equal((await divergingInput('(x) => x * 2', '(x) => x + x')).found, false);

// throw/dönüş sınıfı ayrımı ve desteklenmeyen yapı
const th = await proveEquivalent('function f(x) { if (x === 0) throw 1; return 1; }', 'function g(x) { return 1; }');
assert.equal(th.status, 'refuted');
assert.deepEqual(th.minimized, [0]);
assert.equal((await proveEquivalent('function f(x) { return foo(x); }', '(x) => x')).status, 'unsupported');
assert.equal((await proveEquivalent('function f(x) { while (x > 0) x--; return x; }', '(x) => x > 0 ? 0 : x', { bound: 3 })).status, 'unknown');

console.log('symbolic: ok');
