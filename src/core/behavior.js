const MAX_LEN = 1_000_000;
const MAX_LINES = 2000;

// Kodu sandbox'ta çalıştırıp console çıktısını davranış parmak izi olarak alır.
export async function snapshot(sandbox, code) {
  if (code.length > MAX_LEN) return { ok: false, reason: 'kod çok büyük' };
  const r = await sandbox.run(`try {\n${code}\n} catch (e) { __out.push("!THROW " + (e && e.message)); }`, { timeoutMs: 6000 });
  if (!r.ok) return { ok: false, reason: r.error ?? 'çalıştırılamadı' };
  if (r.out.length > MAX_LINES) return { ok: false, reason: 'çıktı çok uzun' };
  return { ok: true, lines: r.out };
}

export function same(a, b) {
  if (!b.ok) return false;
  return a.lines.length === b.lines.length && a.lines.every((l, i) => l === b.lines[i]);
}
