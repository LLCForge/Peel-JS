import { sandboxApi } from './core.js';
import { applySettings, getSettings } from './settings.js';

// Ana thread tarafı: sandbox worker'ına RPC. kill() çalışan her şeyi keser.
let worker = null;
let seq = 0;
const pending = new Map();

function failAll(error) {
  for (const resolve of pending.values()) resolve({ ok: false, error, out: [], res: [], results: [] });
  pending.clear();
}

function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL('./sandbox.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const resolve = pending.get(e.data.id);
    if (resolve) {
      pending.delete(e.data.id);
      resolve(e.data);
    }
  };
  worker.onerror = (e) => {
    worker?.terminate();
    worker = null;
    failAll(e.message || 'Sandbox worker hatası');
  };
  return worker;
}

function send(msg) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    // arayüz ayarları (profil, zaman, depolama, sınırlar) her isteğe aynı biçimde uygulanır
    ensure().postMessage({ id, ...applySettings(msg, getSettings()) });
  });
}

export const sandbox = {
  ...sandboxApi(send),
  async health() {
    const r = await send({ type: 'batch', list: ['1+1'] });
    return r.ok && r.results?.[0]?.value === 2;
  },
  kill() {
    worker?.terminate();
    worker = null;
    failAll('Durduruldu');
  },
};
