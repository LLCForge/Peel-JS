// Doğrulama API'si: fonksiyon eşdeğerlik kanıtı (E701), sınırlı model kontrolü (E702),
// ayrışan girdi ve yol koşulu (E703), tanık (E704), küçültülmüş karşı örnek (E705),
// yol keşfi (E733–E737) ve girdi sentezi (E739). Kullanıcı kodu hiç çalıştırılmaz: tanıklar terim
// değerlendirmesiyle doğrulanır.
import { execute, firstFunction, encodeResult, truthy, Unsupported, TAG } from './engine.js';
import { mk, bvConst, bvVar, and, or, not, evalTerm, show, FALSE } from '../solver/bv.js';
import { checkSat, minimize, witness, int32Of, ConstraintStore } from '../solver/smt.js';

const now = () => Date.now();

function run(src, opts) {
  return execute(firstFunction(src), opts);
}

const isIncomplete = (tag) => or(mk('eq', tag, bvConst(TAG.bound)), mk('eq', tag, bvConst(TAG.limit)));
const KIND = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));

function describe(enc, model) {
  const kind = KIND[Number(evalTerm(enc.tag, model))];
  const raw = evalTerm(enc.val, model);
  return { kind, value: kind === 'num' ? Number(raw) : kind === 'bool' ? raw === 1n : undefined };
}

const takenPath = (res, model) => {
  const o = res.outcomes.find((x) => evalTerm(x.pc, model) === true);
  return o ? show(o.pc) : null;
};

async function compare(srcA, srcB, opts = {}) {
  const t0 = now();
  let ra;
  let rb;
  try {
    ra = run(srcA, opts);
    rb = run(srcB, opts);
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message, ms: now() - t0 };
    throw e;
  }
  let ea;
  let eb;
  try {
    ea = encodeResult(ra.outcomes);
    eb = encodeResult(rb.outcomes);
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message, ms: now() - t0 };
    throw e;
  }
  const inputs = [...new Set([...ra.inputs, ...rb.inputs])];
  const incomplete = or(isIncomplete(ea.tag), isIncomplete(eb.tag));
  const diff = or(not(mk('eq', ea.tag, eb.tag)), not(mk('eq', ea.val, eb.val)));
  const goal = and(not(incomplete), diff);
  const r = await checkSat([goal], opts);
  const base = { backend: r.backend, inputs, limited: ra.limited ?? rb.limited ?? null };
  if (r.status === 'sat') {
    const counterexample = inputs.map((n) => int32Of(r.model, n));
    const small = opts.minimize === false ? null : minimize(goal, inputs.map((n) => bvVar(n)), opts);
    const model = small?.model ?? r.model;
    return {
      ...base, status: 'refuted', ms: now() - t0, counterexample,
      minimized: small ? inputs.map((n) => int32Of(model, n)) : null,
      witnessVerified: witness(goal, model),
      a: describe(ea, model), b: describe(eb, model),
      pathA: takenPath(ra, model), pathB: takenPath(rb, model),
    };
  }
  if (r.status === 'unknown') return { ...base, status: 'unknown', ms: now() - t0, reason: r.reason };
  const inc = await checkSat([incomplete], opts);
  if (inc.status === 'unsat') return { ...base, status: 'proved', ms: now() - t0 };
  return { ...base, status: 'unknown', ms: now() - t0, reason: inc.status === 'sat' ? `döngü açma sınırı (${opts.bound ?? 8}) ya da yol sınırı aşılabiliyor` : inc.reason };
}

/**
 * E701/E704/E705: iki fonksiyon tüm int32 girdilerde aynı sınıf (dönüş tipi / throw) ve değeri mi veriyor?
 * @returns {Promise<{ status: 'proved'|'refuted'|'unknown'|'unsupported', backend?: string, ms: number,
 *   counterexample?: number[], minimized?: number[]|null, witnessVerified?: boolean, reason?: string }>}
 */
export async function proveEquivalent(srcA, srcB, opts = {}) {
  const r = await compare(srcA, srcB, opts);
  delete r.pathA;
  delete r.pathB;
  return r;
}

/** E703: iki fonksiyonun ayrıştığı girdi ve her birinin izlediği yol koşulu */
export async function divergingInput(srcA, srcB, opts = {}) {
  const r = await compare(srcA, srcB, opts);
  if (r.status !== 'refuted') return { found: false, status: r.status, reason: r.reason ?? null, ms: r.ms };
  return { found: true, input: r.minimized ?? r.counterexample, a: r.a, b: r.b, pathA: r.pathA, pathB: r.pathB, backend: r.backend, ms: r.ms };
}

/**
 * E702: sınırlı model kontrolü. `property` parametre adları ve `result` üzerinde JS ifadesi;
 * en fazla `bound` döngü yinelemeli tüm yürütmelerde dönüş değeri için denetlenir.
 * @returns {Promise<{ status: 'holds'|'violated'|'unknown'|'unsupported', complete?: boolean, bound: number,
 *   counterexample?: number[], minimized?: number[]|null, result?: object, reason?: string, ms: number }>}
 */
export async function boundedCheck(src, property, { bound = 8, ...opts } = {}) {
  const t0 = now();
  const o = { ...opts, bound };
  try {
    const res = run(src, o);
    const propFn = firstFunction(`function __peelProp(${[...res.params, 'result'].join(', ')}) { return (${property}); }`);
    const holds = (value) => {
      const p = execute(propFn, { ...o, bind: new Map([['result', value]]) });
      return or(...p.outcomes.map((x) => (x.kind === 'return' ? and(x.pc, truthy(x.value)) : x.kind === 'throw' ? FALSE : x.pc)));
    };
    const violations = or(...res.outcomes.filter((x) => x.kind === 'return').map((x) => and(x.pc, not(holds(x.value)))));
    const reached = or(...res.outcomes.filter((x) => x.kind === 'bound' || x.kind === 'limit').map((x) => x.pc));
    const r = await checkSat([violations], opts);
    if (r.status === 'sat') {
      const small = minimize(violations, res.inputs.map((n) => bvVar(n)), opts);
      const model = small?.model ?? r.model;
      const enc = encodeResult(res.outcomes);
      return { status: 'violated', bound, ms: now() - t0, counterexample: res.inputs.map((n) => int32Of(r.model, n)),
        minimized: small ? res.inputs.map((n) => int32Of(model, n)) : null, result: describe(enc, model), backend: r.backend };
    }
    if (r.status === 'unknown') return { status: 'unknown', bound, reason: r.reason, ms: now() - t0 };
    const inc = await checkSat([reached], opts);
    return { status: 'holds', bound, complete: inc.status === 'unsat', ms: now() - t0, backend: r.backend,
      reason: inc.status === 'unsat' ? null : `yalnızca ${bound} yinelemeye kadar denetlendi` };
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', bound, reason: e.message, ms: now() - t0 };
    throw e;
  }
}

/**
 * E733–E737: yol keşfi. Birleştirme kapalıysa (merge:false) her tam yol ayrı listelenir.
 * @returns {{ status: 'ok'|'unsupported', reason?: string, params?: string[], inputs?: string[],
 *   paths?: { kind: string, pc: string, value: string|null }[], forks?: number, merges?: number,
 *   pruned?: number, limited?: string|null, store?: object|null }}
 */
export function explore(src, opts = {}) {
  try {
    const r = run(src, opts);
    return {
      status: 'ok', params: r.params, inputs: r.inputs, forks: r.forks, merges: r.merges, pruned: r.pruned,
      limited: r.limited, store: r.store,
      paths: r.outcomes.map((o) => ({ kind: o.kind === 'return' ? `return:${o.value.k}` : o.kind, pc: show(o.pc), value: o.value?.t ? show(o.value.t) : null })),
    };
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message };
    throw e;
  }
}

/**
 * E739: her olanaklı yol için çözücüyle üretilmiş argüman vektörü.
 * @returns {{ inputs: number[][], paths: { kind: string, pc: string, input: number[]|null }[], limited: string|null, status: string, reason?: string }}
 */
export function synthesizeInputs(src, { maxPaths = 64, bound = 8, ...opts } = {}) {
  let r;
  try {
    r = run(src, { ...opts, maxPaths, bound, merge: false, prune: true });
  } catch (e) {
    if (e instanceof Unsupported) return { status: 'unsupported', reason: e.message, inputs: [], paths: [], limited: null };
    throw e;
  }
  const store = new ConstraintStore({ timeoutMs: 2000, maxConflicts: 50_000 });
  const seen = new Set();
  const inputs = [];
  const paths = r.outcomes.map((o) => {
    const c = store.check([o.pc]);
    if (c.status !== 'sat') return { kind: o.kind, pc: show(o.pc), input: null };
    const input = r.inputs.map((n) => int32Of(c.model, n));
    const key = input.join(',');
    if (!seen.has(key)) { seen.add(key); inputs.push(input); }
    return { kind: o.kind, pc: show(o.pc), input };
  });
  return { status: 'ok', inputs, paths, limited: r.limited, params: r.params };
}
