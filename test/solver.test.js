// Çözücü öz-denetimi: node test/solver.test.js
import assert from 'node:assert/strict';
import { Sat } from '../src/verify/solver/sat.js';
import { bvVar, bvConst, mk, evalTerm } from '../src/verify/solver/bv.js';
import { checkSat, minimize, witness, int32Of } from '../src/verify/solver/smt.js';
import { z3Available, shutdownZ3 } from '../src/verify/solver/z3.js';
import { proveEquivalent } from '../src/verify/symbolic/api.js';

// SAT temelleri
let s = new Sat();
const [a, b, c] = [s.newVar(), s.newVar(), s.newVar()];
s.addClause([a, b]); s.addClause([-a, c]); s.addClause([-b, c]);
assert.equal(s.solve(), 'sat');
assert.equal(s.model[c], 1);
s.addClause([-c]);
assert.equal(s.solve(), 'unsat');
// güvercin yuvası 4→3: UNSAT
s = new Sat();
const p = Array.from({ length: 4 }, () => Array.from({ length: 3 }, () => s.newVar()));
for (const row of p) s.addClause(row);
for (let h = 0; h < 3; h++) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) s.addClause([-p[i][h], -p[j][h]]);
assert.equal(s.solve(), 'unsat');
// varsayımlar artımlı: aynı örnek iki farklı sonuç
s = new Sat();
const x1 = s.newVar();
const x2 = s.newVar();
s.addClause([x1, x2]);
assert.equal(s.solve({ assumptions: [-x1, -x2] }), 'unsat');
assert.equal(s.solve({ assumptions: [-x1] }), 'sat');

// MBA özdeşliği: yerleşik çözücü ve Z3
const x = mk('sext32', bvVar('x'));
const y = mk('sext32', bvVar('y'));
const mba = mk('bnot', mk('eq', mk('add', mk('xor', x, y), mk('mul', bvConst(2), mk('and', x, y))), mk('add', x, y)));
const rb = await checkSat([mba], { backend: 'builtin' });
assert.equal(rb.status, 'unsat');
assert.ok(rb.ms < 5000, `MBA çok yavaş: ${rb.ms} ms`);
const eq = await proveEquivalent('function f(x, y) { return (x ^ y) + 2 * (x & y); }', '(a, b) => a + b', { backend: 'builtin' });
assert.equal(eq.status, 'proved');
if (await z3Available()) {
  assert.equal((await checkSat([mba], { backend: 'z3' })).status, 'unsat');
  const ez = await proveEquivalent('function f(x, y) { return (x | y) - (x & y); }', '(a, b) => a ^ b', { backend: 'z3' });
  assert.equal(ez.status, 'proved');
  assert.equal(ez.backend, 'z3');
} else {
  console.log('solver: z3 yok, yalnızca yerleşik çözücü denendi');
}

// çürütme + tanık + küçültülmüş karşı örnek: x + 1 > x, x = 2^31-1'de taşmaz ama int32'de (x+1|0) taşar
const wrap = mk('bnot', mk('slt', x, mk('sext32', mk('add', x, bvConst(1)))));
const r = await checkSat([wrap], { backend: 'builtin' });
assert.equal(r.status, 'sat');
assert.ok(witness(wrap, r.model));
assert.equal(int32Of(r.model, 'x'), 2147483647);
const ref = await proveEquivalent('function f(x) { return x > 100 ? x - 1 : x; }', 'function g(x) { return x; }');
assert.equal(ref.status, 'refuted');
assert.ok(ref.witnessVerified);
assert.deepEqual(ref.minimized, [101]);
const small = minimize(mk('slt', bvConst(1000), x), [bvVar('x')]);
assert.equal(int32Of(small.model, 'x'), 1001);
assert.equal(evalTerm(mk('add', bvConst(2), bvConst(3))), 5n);

// zaman aşımı → unknown (64 bit çarpanlara ayırma, 50 ms bütçe)
const hard = mk('eq', mk('mul', x, y), bvConst(1000003n * 999983n));
const t = await checkSat([mk('band', hard, mk('slt', bvConst(1), x))], { backend: 'builtin', timeoutMs: 50 });
assert.equal(t.status, 'unknown');
assert.match(t.reason, /zaman aşımı|bütçe/);
const tc = await checkSat([hard], { backend: 'builtin', maxConflicts: 10 });
assert.equal(tc.status, 'unknown');

await shutdownZ3();
console.log('solver: ok');
