// Z3 çevirisi ve denetimi: Node arka ucu ve tarayıcı worker'ı ortak kullanır (terimler bv.js biçiminde).
import { W } from './bv.js';

function translate(Z, t, memo) {
  const hit = memo.get(t.id);
  if (hit) return hit;
  const a = () => translate(Z, t.args[0], memo);
  const b = () => translate(Z, t.args[1], memo);
  const amt = () => b().and(Z.BitVec.val(63n, W));
  let r;
  switch (t.op) {
    case 'const': r = Z.BitVec.val(BigInt.asUintN(W, t.val), W); break;
    case 'var': r = Z.BitVec.const(t.val, W); break;
    case 'bconst': r = Z.Bool.val(t.val === 1); break;
    case 'bvar': r = Z.Bool.const(t.val); break;
    case 'add': r = a().add(b()); break;
    case 'sub': r = a().sub(b()); break;
    case 'mul': r = a().mul(b()); break;
    case 'and': r = a().and(b()); break;
    case 'or': r = a().or(b()); break;
    case 'xor': r = a().xor(b()); break;
    case 'not': r = a().not(); break;
    case 'neg': r = a().neg(); break;
    case 'shl': r = a().shl(amt()); break;
    case 'ashr': r = a().shr(amt()); break;
    case 'lshr': r = a().lshr(amt()); break;
    case 'sext32': r = a().extract(31, 0).signExt(32); break;
    case 'zext32': r = Z.Concat(Z.BitVec.val(0n, 32), a().extract(31, 0)); break;
    case 'ite': r = Z.If(a(), b(), translate(Z, t.args[2], memo)); break;
    case 'eq': r = a().eq(b()); break;
    case 'slt': r = a().slt(b()); break;
    case 'sle': r = a().sle(b()); break;
    case 'ult': r = a().ult(b()); break;
    case 'bnot': r = a().not(); break;
    case 'band': r = a().and(b()); break;
    case 'bor': r = a().or(b()); break;
    default: throw new Error(`z3: desteklenmeyen terim ${t.op}`);
  }
  memo.set(t.id, r);
  return r;
}

/** @returns {Promise<{ status, backend: 'z3', ms, model?, reason? }>} */
export async function checkWith(Z, goal, timeoutMs) {
  const t0 = Date.now();
  try {
    const memo = new Map();
    const solver = new Z.Solver();
    solver.set('timeout', Math.max(1, Math.round(timeoutMs)));
    solver.add(translate(Z, goal, memo));
    const status = await solver.check();
    const out = { status, backend: 'z3', ms: Date.now() - t0 };
    if (status === 'unknown') out.reason = solver.reasonUnknown?.() || 'zaman aşımı';
    if (status === 'sat') {
      const m = solver.model();
      out.model = {};
      const seen = new Set();
      const walk = (x) => {
        if (seen.has(x.id)) return;
        seen.add(x.id);
        if (x.op === 'var') out.model[x.val] = BigInt.asIntN(W, m.eval(memo.get(x.id), true).value());
        if (x.op === 'bvar') out.model[x.val] = String(m.eval(memo.get(x.id), true)) === 'true';
        x.args.forEach(walk);
      };
      walk(goal);
    }
    return out;
  } catch (e) {
    return { status: 'unknown', backend: 'z3', ms: Date.now() - t0, reason: `z3 hatası: ${e?.message ?? e}` };
  }
}
