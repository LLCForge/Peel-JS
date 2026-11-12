// Z3 wasm arka ucu (E724).
// - Node/CLI: paket isteğe bağlı; modül adı değişkende tutulur (@vite-ignore), pthread'ler boşta kapatılır.
// - Tarayıcı: Z3'ün pthread derlemesi SharedArrayBuffer ister → sayfa cross-origin isolated olmalı
//   (COOP same-origin + COEP require-corp; vite.config.js ve public/_headers). Öyleyse Z3 tembel yüklenen ayrı bir
//   worker'da çalışır; değilse "kullanılamıyor" döner ve yerleşik CDCL çözücü kullanılır.
import { checkWith } from './z3-core.js';

const MODULE = 'z3-solver';
const IDLE_MS = 1500;
const BROWSER_IDLE_MS = 60000;
let pending = null;
let idleTimer = null;
let unavailable = null;

const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node) && typeof window === 'undefined';

// Tarayıcı: worker RPC (tek seferde bir istek sırası yeterli; Z3 içeride zaten tek bağlam)
function browserBackend() {
  if (!globalThis.crossOriginIsolated) return { error: 'tarayıcı: sayfa cross-origin isolated değil (COOP/COEP başlıkları yok), yerleşik çözücü kullanılıyor' };
  if (typeof Worker === 'undefined') return { error: 'tarayıcı: Worker yok' };
  const w = new Worker(new URL('./z3.worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const waits = new Map();
  w.onmessage = (e) => { const r = waits.get(e.data.id); if (r) { waits.delete(e.data.id); r(e.data.result); } };
  w.onerror = (e) => { for (const r of waits.values()) r({ status: 'unknown', backend: 'z3', ms: 0, reason: `z3 worker: ${e.message}` }); waits.clear(); };
  const call = (payload) => new Promise((resolve) => { const id = ++seq; waits.set(id, resolve); w.postMessage({ id, ...payload }); });
  return { call, terminate: () => w.terminate() };
}

async function load() {
  if (unavailable) return null;
  pending ??= (async () => {
    if (isNode) {
      const mod = await import(/* @vite-ignore */ MODULE);
      const api = await mod.init();
      const ctx = api.Context('peel');
      return { check: (goal, ms) => checkWith(ctx, goal, ms), stop: () => api.em.PThread.terminateAllThreads() };
    }
    const b = browserBackend();
    if (b.error) throw new Error(b.error);
    const ready = await b.call({ type: 'init' });
    if (!ready?.ok) { b.terminate(); throw new Error(ready?.error ?? 'z3 worker başlatılamadı'); }
    return { check: (goal, ms) => b.call({ type: 'check', goal, timeoutMs: ms }), stop: () => b.terminate() };
  })().catch((e) => { unavailable = e.message?.startsWith('tarayıcı') ? e.message : `z3 yüklenemedi: ${e?.message ?? e}`; pending = null; return null; });
  return pending;
}

function scheduleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdownZ3, isNode ? IDLE_MS : BROWSER_IDLE_MS);
  idleTimer.unref?.();
}

export async function shutdownZ3() {
  clearTimeout(idleTimer);
  const p = pending;
  pending = null;
  const z = p && (await p);
  z?.stop();
}

export async function z3Available() {
  return Boolean(await load());
}

export const z3Status = () => (unavailable ? { available: false, reason: unavailable } : { available: pending ? true : null });

/** @returns {Promise<{ status, backend: 'z3', ms, model?, reason? }>} */
export async function z3Check(goal, { timeoutMs = 5000 } = {}) {
  const z = await load();
  if (!z) return { status: 'unknown', backend: 'z3', ms: 0, reason: unavailable };
  try {
    return await z.check(goal, timeoutMs);
  } finally {
    scheduleShutdown();
  }
}
