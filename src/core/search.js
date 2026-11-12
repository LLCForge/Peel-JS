// Motor stratejileri (E32, E33, E34, E36): pass sırası arama, kademeli saldırı, bağımlı pass'leri kapsayan
// geri alma zinciri ve seçili bölgede artımlı çözme. Hepsi deobfuscate()'i farklı ayarlarla çağırır;
// sonuçlar gizlilik skoruyla (düşük = daha okunur) ve davranış doğrulamasıyla karşılaştırılır.
import * as t from '@babel/types';
import { deobfuscate } from './pipeline.js';
import { PASSES } from './registry.js';
import { parse } from './parse.js';
import { traverse, generate } from '../util/ast.js';
import { snapshot, same } from './behavior.js';

// Gizlilik skoru: gizleme kalıntıları ağırlıklı; boyut küçük etkili (eşitlik bozucu)
export function obfuscationScore(code) {
  let ast;
  try { ast = parse(code); } catch { return Infinity; }
  let ids = 0;
  let hexCalls = 0;
  let dispatchers = 0;
  let escapes = 0;
  traverse(ast, {
    Identifier(p) { if (/^(_0x[0-9a-f]+|__p_\w+)$/i.test(p.node.name)) ids++; },
    CallExpression(p) {
      const a = p.node.arguments;
      if (t.isIdentifier(p.node.callee) && a.length && a.length <= 3 && t.isNumericLiteral(a[0])) hexCalls++;
    },
    SwitchStatement(p) { if (p.findParent((x) => x.isLoop())) dispatchers++; },
    StringLiteral(p) { if (/\\x|\\u/.test(p.node.extra?.raw ?? '')) escapes++; },
  });
  return ids * 2 + hexCalls * 5 + dispatchers * 20 + escapes + code.length / 2000;
}

const AST_IDS = PASSES.filter((p) => p.kind === 'ast').map((p) => p.id);
const move = (list, ids, front) => {
  const picked = list.filter((x) => ids.includes(x));
  const rest = list.filter((x) => !ids.includes(x));
  return front ? [...picked, ...rest] : [...rest, ...picked];
};

// Aday sıralar: kayıt sırası, decoder'lar önce, yapı önce, ters, ve tohumlu rastgele karıştırmalar
export function candidateOrders(extra = 2, seed = 7) {
  const out = [
    { name: 'varsayılan', order: AST_IDS },
    { name: 'decoder önce', order: move(AST_IDS, ['static-decode', 'string-array', 'runtime-decoders', 'wrappers', 'const-fold'], true) },
    { name: 'yapı önce', order: move(AST_IDS, ['dispatcher', 'unflatten', 'control-flow', 'state-var', 'dead-code', 'opaque', 'restructure'], true) },
    { name: 'ters', order: [...AST_IDS].reverse() },
  ];
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  for (let k = 0; k < extra; k++) {
    const o = [...AST_IDS];
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    out.push({ name: `karışık #${k + 1}`, order: o });
  }
  return out;
}

/** E32: aday sıraları dener, doğrulanmış ve skoru en düşük sonucu seçer */
export async function searchPassOrder(input, { sandbox = null, level = 4, extra = 2, signal = null, onLog = () => {} } = {}) {
  const tried = [];
  for (const cand of candidateOrders(extra)) {
    if (signal?.aborted) break;
    const r = await deobfuscate(input, { level, order: cand.order, sandbox, deep: Boolean(sandbox), signal });
    if (r.error) { tried.push({ name: cand.name, error: r.error }); continue; }
    const score = obfuscationScore(r.code);
    tried.push({ name: cand.name, order: cand.order, score: Number(score.toFixed(2)), verified: Boolean(r.verified), rollbacks: r.events.filter((e) => e.state === 'fail').length, code: r.code });
    onLog(`sıra arama: ${cand.name} → skor ${score.toFixed(1)}`, 'info');
  }
  const ok = tried.filter((x) => !x.error);
  // doğrulanmış sonuçlar doğrulanmamışlardan önce gelir; sonra skor, sonra geri alma sayısı
  ok.sort((a, b) => Number(b.verified) - Number(a.verified) || a.score - b.score || a.rollbacks - b.rollbacks);
  return { best: ok[0] ?? null, tried: tried.map(({ code, ...x }) => x) };
}

/** E33: kademeli saldırı — seviye 1'den 4'e, her aşamanın doğrulanmış çıktısı bir sonrakinin girdisi */
export async function cascade(input, { sandbox = null, signal = null, onLog = () => {} } = {}) {
  const stages = [];
  let code = input;
  let best = obfuscationScore(input);
  for (const level of [1, 2, 3, 4]) {
    if (signal?.aborted) break;
    const r = await deobfuscate(code, { level, sandbox, deep: Boolean(sandbox), signal });
    if (r.error) { stages.push({ level, error: r.error }); break; }
    const score = obfuscationScore(r.code);
    const improved = score < best - 0.01;
    stages.push({ level, score: Number(score.toFixed(2)), improved, verified: Boolean(r.verified), rollbacks: r.events.filter((e) => e.state === 'fail').length });
    onLog(`kademe ${level}: skor ${score.toFixed(1)}${improved ? '' : ' (iyileşme yok)'}`, 'info');
    // sandbox varken doğrulanamayan aşama kabul edilmez: bir önceki doğrulanmış kod korunur
    if (sandbox && !r.verified) continue;
    if (improved || level === 1) { code = r.code; best = Math.min(best, score); }
  }
  return { code, score: Number(best.toFixed(2)), stages };
}

/**
 * E34: zaman çizelgesi anlık görüntülerinden davranışı ilk bozan pass'i bulur (ikili arama), o pass'i
 * ve ona dayanarak sonradan değişiklik yapan tüm pass'leri geri alır, ardından bozucu pass'i dışarıda
 * bırakarak yeniden çalıştırır (bağımlı pass'ler kendi doğrulamalarıyla yeniden uygulanır).
 */
export async function rollbackChain(input, snapshots, { sandbox, level = 4, signal = null } = {}) {
  if (!sandbox) throw new Error('geri alma zinciri sandbox gerektirir');
  const base = await snapshot(sandbox, input);
  if (!base.ok) return { culprit: null, reason: `girdi çalıştırılamadı: ${base.reason}` };
  const steps = snapshots.filter((s) => s.id !== 'girdi');
  const okAt = async (i) => same(base, await snapshot(sandbox, steps[i].code));
  if (!steps.length || await okAt(steps.length - 1)) return { culprit: null, reason: 'son çıktı girdiyle aynı davranıyor' };
  let lo = 0;
  let hi = steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await okAt(mid)) lo = mid + 1; else hi = mid;
  }
  const culprit = steps[lo];
  const dependents = [...new Set(steps.slice(lo + 1).map((s) => s.id))].filter((id) => id !== culprit.id);
  const only = PASSES.filter((p) => p.level <= level && p.id !== culprit.id).map((p) => p.id);
  const rerun = await deobfuscate(input, { only, sandbox, deep: true, signal });
  const fixed = !rerun.error && same(base, await snapshot(sandbox, rerun.code));
  return { culprit: { id: culprit.id, round: culprit.round }, dependents, excluded: [culprit.id], code: rerun.code, fixed };
}

/**
 * E36: seçili bölgede artımlı çözme. Seçimi kapsayan en içteki fonksiyon işaretlenir, program bağlamıyla
 * birlikte çözülür ve yalnızca o fonksiyonun çözülmüş hâli orijinal koda yerleştirilir; geri kalan kod
 * değişmez. Bölge dışındaki tanımlara yapılan referanslar korunmuyorsa ya da davranış değişirse reddedilir.
 */
const MARK = 'peel:region';
export async function deobfuscateRegion(code, start, end, { sandbox = null, level = 4, signal = null } = {}) {
  const ast = parse(code);
  let target = null;
  traverse(ast, {
    Function(p) {
      const n = p.node;
      if (n.start <= start && n.end >= end && t.isBlockStatement(n.body)) {
        if (!target || n.end - n.start < target.node.end - target.node.start) target = p;
      }
    },
  });
  if (!target) return { ok: false, reason: 'seçim bir fonksiyonun içinde değil: tüm programı çözün' };
  const { start: fs, end: fe } = target.node;
  target.node.body.directives.unshift(t.directive(t.directiveLiteral(MARK)));
  const marked = generate(ast, { jsescOption: { minimal: true } }).code;
  // rename kapalı: bölge dışında kalan adlar orijinalle eşleşmeli
  const only = PASSES.filter((p) => p.level <= level && p.id !== 'rename').map((p) => p.id);
  const r = await deobfuscate(marked, { only, sandbox, deep: Boolean(sandbox), signal });
  if (r.error) return { ok: false, reason: r.error };
  let piece = null;
  let free = null;
  traverse(parse(r.code), {
    Function(p) {
      const dirs = p.node.body?.directives ?? [];
      const i = dirs.findIndex((d) => d.value.value === MARK);
      if (i < 0 || piece) return;
      dirs.splice(i, 1);
      free = new Set();
      p.traverse({ Identifier(q) { if (q.isReferencedIdentifier() && !q.scope.hasBinding(q.node.name, true)) free.add(q.node.name); } });
      // dış kapsamdaki adlar (program ya da üst fonksiyonlar)
      p.traverse({ Identifier(q) { if (q.isReferencedIdentifier()) { const b = q.scope.getBinding(q.node.name); if (b && !b.path.findParent((x) => x === p)) free.add(q.node.name); } } });
      piece = generate(p.node, { jsescOption: { minimal: true } }).code;
    },
  });
  if (!piece) return { ok: false, reason: 'çözülmüş kodda bölge bulunamadı (fonksiyon kaldırıldı ya da satır içine alındı)' };
  // orijinal programda görünen adlar: bölge bunların dışında bir ada (ör. silinmiş decoder'ın yerine üretilen yardımcı) bağlıysa reddet
  const known = new Set();
  traverse(parse(code), { Identifier(q) { known.add(q.node.name); } });
  const unknown = [...free].filter((n) => !known.has(n) && !(n in globalThis));
  if (unknown.length) return { ok: false, reason: `bölge dışarıda olmayan adlara bağlı: ${unknown.slice(0, 5).join(', ')}` };
  // fonksiyon ifadesi ise parantez/ad durumu korunur: kaynak dilimiyle değiştir
  const merged = code.slice(0, fs) + piece + code.slice(fe);
  try { parse(merged); } catch (e) { return { ok: false, reason: `birleştirilen kod parse edilemedi: ${e.message}` }; }
  if (sandbox) {
    const [a, b] = [await snapshot(sandbox, code), await snapshot(sandbox, merged)];
    if (a.ok && !same(a, b)) return { ok: false, reason: 'bölge değişikliği davranışı değiştirdi' };
  }
  return { ok: true, code: merged, region: { start: fs, end: fs + piece.length }, before: code.slice(fs, fe), after: piece };
}
