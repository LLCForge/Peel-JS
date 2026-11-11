import { parse } from './parse.js';
import { verify } from './verify.js';
import { raw, pretty } from './emit.js';
import { fnv1a } from '../util/hash.js';
import { PASSES } from './registry.js';
import { snapshot, same } from './behavior.js';

const MAX_ROUNDS = 25;
const CONTEXT_MAX_LEN = 2_000_000;
const DEEP_MAX_LEN = 120_000;

/**
 * @param {string} input
 * @param {object} o
 * @param {object|null} o.sandbox  sandboxApi uyumlu nesne; null ise sandbox pass'leri atlanır
 */
export async function deobfuscate(input, {
  level = 2, only = null, sandbox = null, deep = false, signal = null,
  onLog = () => {}, onProgress = () => {}, onPass = () => {}, onSnapshot = () => {},
} = {}) {
  const stats = {};
  const bump = (k, n = 1) => { if (n) stats[k] = (stats[k] || 0) + n; };
  const checkAbort = () => { if (signal?.aborted) throw new Error('İptal edildi'); };

  let enabled = PASSES.filter((p) => (only ? only.includes(p.id) : p.level <= level));
  if (!sandbox) enabled = enabled.filter((p) => p.needs !== 'sandbox');
  const textPasses = enabled.filter((p) => p.kind === 'text');
  const astPasses = enabled.filter((p) => p.kind === 'ast');

  const totalSteps = Math.max(1, textPasses.length + astPasses.length * 2);
  let step = 0;
  const tick = () => onProgress(Math.min(99, Math.round((++step / totalSteps) * 100)));

  const ctx = { onLog, bump, level, sandbox, ctx: null };

  // Pass başına süre ve sonuç: rapor ve zaman çizelgesi için
  const events = [];
  let passStart = 0;
  let round = 0;
  const pass = (id, state, reason) => {
    if (state === 'run') passStart = performance.now();
    else events.push({ id, round, state, ms: Math.round(performance.now() - passStart), reason });
    onPass(id, state);
  };

  // 1) metin pass'leri: parse öncesi sarmalayıcı/kodlayıcı katmanları
  let text = input;
  for (const p of textPasses) {
    checkAbort();
    pass(p.id, 'run');
    try {
      const next = await p.mod.run(text, ctx);
      checkAbort();
      if (typeof next === 'string' && next !== text) {
        text = next;
        pass(p.id, 'ok');
      } else {
        pass(p.id, 'skip');
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      onLog(`${p.id}: ${e.message}`, 'warn');
      pass(p.id, 'fail');
    }
    tick();
  }

  let code;
  try {
    code = raw(parse(text));
  } catch (e) {
    return { code: text, stats, events, text, error: e.message };
  }
  onSnapshot({ id: 'girdi', round: 0, code });

  try {
    // 2) değerlendirme bağlamı: program bir kez yüklenir, decoder'lar o bağlamda çağrılır
    if (sandbox && text.length <= CONTEXT_MAX_LEN) {
      const r = await sandbox.open(text, { timeoutMs: 8000 });
      checkAbort();
      if (r.ok) {
        ctx.ctx = r.token;
        onLog(r.runError ? `bağlam açıldı, program hata verdi: ${r.runError}` : 'değerlendirme bağlamı açıldı', r.runError ? 'warn' : 'info');
      } else {
        onLog(`bağlam açılamadı: ${r.error}`, 'warn');
      }
    }

    let baseline = null;
    if (deep && sandbox) {
      if (text.length > DEEP_MAX_LEN) {
        onLog('derin doğrulama kapalı: kod çok büyük', 'warn');
      } else {
        const snap = await snapshot(sandbox, code);
        checkAbort();
        if (snap.ok) {
          baseline = snap;
          onLog(`davranış temeli alındı (${snap.lines.length} satır)`, 'info');
        } else {
          onLog(`derin doğrulama kapalı: ${snap.reason}`, 'warn');
        }
      }
    }

    // 3) AST pass'leri: değişiklik durana kadar tur
    const seen = new Set([fnv1a(code)]);
    for (round = 1; round <= MAX_ROUNDS; round++) {
      let changed = false;
      for (const p of astPasses) {
        checkAbort();
        pass(p.id, 'run');
        // her pass taze ağaçla başlar: Babel'in scope önbelleği önceki pass'in mutasyonlarından etkilenmez
        const ast = parse(code);
        try {
          await p.mod.run(ast, ctx);
          checkAbort();
        } catch (e) {
          if (signal?.aborted) throw e;
          onLog(`${p.id}: ${e.message}, geri alındı`, 'warn');
          pass(p.id, 'fail', `hata: ${e.message}`);
          tick();
          continue;
        }
        const v = verify(ast);
        if (!v.ok) {
          onLog(`${p.id}: doğrulama başarısız (${v.reason}), geri alındı`, 'warn');
          pass(p.id, 'fail', `parse: ${v.reason}`);
          tick();
          continue;
        }
        if (v.code === code) {
          pass(p.id, 'skip');
          tick();
          continue;
        }
        if (baseline) {
          const snap = await snapshot(sandbox, v.code);
          checkAbort();
          if (!same(baseline, snap)) {
            onLog(`${p.id}: davranış değişti, geri alındı`, 'warn');
            pass(p.id, 'fail', 'davranış');
            tick();
            continue;
          }
        }
        code = v.code;
        changed = true;
        pass(p.id, 'ok');
        onSnapshot({ id: p.id, round, code });
        tick();
      }
      const h = fnv1a(code);
      if (!changed || seen.has(h)) break;
      seen.add(h);
    }
  } finally {
    // iptalde worker zaten öldürüldü: bağlamı kapatmak için yenisini başlatma
    if (ctx.ctx && !signal?.aborted) await sandbox.close(ctx.ctx);
  }

  const out = await pretty(code);
  onProgress(100);
  // text: metin katmanları açıldıktan sonraki program; rapor çalışma anı analizini bunun üzerinde yapar
  return { code: out, stats, events, text };
}
