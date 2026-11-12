// SMT katmanı: bool terim kümesi için sat/unsat/unknown, model, tanık doğrulama ve karşı örnek küçültme.
// Arka uç: 'builtin' (CDCL + bit-blasting, her ortamda), 'z3' (Z3 wasm, yalnızca uygun ortamda),
// 'auto' (önce yerleşik, bütçe aşılırsa Z3 varsa onunla tekrar).
import { Sat } from './sat.js';
import { Blaster, evalTerm, varsOf, and, mk, bvConst } from './bv.js';
import { z3Check, z3Available } from './z3.js';

export const DEFAULT_BUDGET = { timeoutMs: 5000, maxConflicts: 200_000 };

// Artımlı kısıt deposu: tek SAT örneği, terimler bir kez bit-blast edilir, sorgular varsayımla çözülür,
// sonuçlar terim id'sine göre önbelleklenir (E734).
export class ConstraintStore {
  constructor(budget = {}) {
    this.sat = new Sat();
    this.blaster = new Blaster(this.sat);
    this.budget = { ...DEFAULT_BUDGET, ...budget };
    this.cache = new Map();
    this.stats = { queries: 0, hits: 0, unknown: 0 };
    this.asserted = [];
  }

  assert(t) { this.asserted.push(t); this.sat.addClause([this.blaster.lit(t)]); this.cache.clear(); }

  // t ile birlikte sağlanabilir mi? (yalnızca durum; model için check kullan)
  feasible(t) {
    this.stats.queries++;
    if (this.cache.has(t.id)) { this.stats.hits++; return this.cache.get(t.id); }
    const r = this.check([t]).status;
    if (r === 'unknown') this.stats.unknown++;
    this.cache.set(t.id, r);
    return r;
  }

  check(terms, budget = {}) {
    const b = { ...this.budget, ...budget };
    const assumptions = terms.map((t) => this.blaster.lit(t));
    const t0 = Date.now();
    const status = this.sat.solve({ assumptions, maxConflicts: b.maxConflicts, deadline: t0 + b.timeoutMs });
    const out = { status, ms: Date.now() - t0, backend: 'builtin' };
    if (status === 'unknown') out.reason = this.sat.budgetHit;
    if (status === 'sat') out.model = this.blaster.read(this.sat.model, varsOf([...this.asserted, ...terms]));
    return out;
  }
}

/**
 * @param {object[]} assertions bool terimler (hepsi birlikte)
 * @param {{ backend?: 'builtin'|'z3'|'auto', timeoutMs?: number, maxConflicts?: number }} o
 * @returns {Promise<{ status: 'sat'|'unsat'|'unknown', backend: string, ms: number, model?: object, reason?: string }>}
 */
export async function checkSat(assertions, { backend = 'auto', ...budget } = {}) {
  const b = { ...DEFAULT_BUDGET, ...budget };
  const goal = and(...assertions);
  if (backend === 'z3') return z3Check(goal, b);
  const r = new ConstraintStore(b).check([goal]);
  if (r.status !== 'unknown' || backend !== 'auto' || !(await z3Available())) return r;
  const z = await z3Check(goal, b);
  return z.status === 'unknown' ? { ...z, reason: `${r.reason}; z3: ${z.reason ?? 'unknown'}` } : z;
}

// E704: tanık — model formülü somut değerlendirmede de sağlıyor mu?
export function witness(goal, model) {
  return evalTerm(goal, model) === true;
}

/**
 * E705: karşı örnek küçültme. Değişkenleri sırayla, yüksek bitten başlayarak 0'a zorlar
 * (önce işaret biti: negatif olmayan değer tercih edilir). Her adım artımlı çözümdür.
 * @param {object} goal bool terim  @param {object[]} vars küçültülecek bv değişken terimleri (int32 girdiler)
 */
export function minimize(goal, vars, budget = {}) {
  const store = new ConstraintStore({ timeoutMs: 3000, maxConflicts: 20_000, ...budget });
  store.assert(goal);
  let best = store.check([]);
  if (best.status !== 'sat') return null;
  const deadline = Date.now() + (budget.totalMs ?? 8000);
  const fixed = [];
  for (const v of vars) {
    for (let bit = 31; bit >= 0; bit--) {
      if (Date.now() > deadline) return { model: best.model, complete: false };
      const mask = bvConst(1n << BigInt(bit));
      const zero = mk('eq', mk('and', v, mask), bvConst(0));
      const r = store.check([...fixed, zero]);
      if (r.status === 'sat') { fixed.push(zero); best = r; }
      else if (r.status === 'unsat') fixed.push(mk('bnot', zero));
      else return { model: best.model, complete: false };
    }
  }
  return { model: best.model, complete: true };
}

// int32 girdi değerini modelden oku
export const int32Of = (model, name) => Number(BigInt.asIntN(32, BigInt(model?.[name] ?? 0)));
