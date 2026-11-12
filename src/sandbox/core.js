import { STUBS } from './stubs.js';
import { SEMANTIC_STUBS } from './semantics-stubs.js';
import { hostIntl, hostTzOffset, hostTzName } from './host-intl.js';

const MAX_CONTEXTS = 2;

// İfadeyi değerlendirip yalnızca primitive sonucu JSON olarak döndüren sarmalayıcı.
const VALUE_OF = (code) => `(function () {
  var v = (function () { return (${code}
  ); })();
  var t = typeof v;
  if (t === "number" && (v !== v || v === 1 / 0 || v === -1 / 0)) return JSON.stringify({ t: "special", v: String(v) });
  if (t === "number" && v === 0 && 1 / v < 0) return JSON.stringify({ t: "negzero" });
  if (v === null || t === "string" || t === "number" || t === "boolean" || t === "undefined")
    return JSON.stringify({ t: v === null ? "null" : t, v: v === undefined ? null : v });
  return JSON.stringify({ t: t });
})()`;

function decodeValue(r) {
  if (!r.ok || typeof r.value !== 'string') return { ok: false, error: r.error };
  const { t, v } = JSON.parse(r.value);
  if (t === 'special') return { ok: true, type: 'number', value: Number(v) };
  if (t === 'undefined') return { ok: true, type: t, value: undefined };
  if (t === 'null' || t === 'string' || t === 'number' || t === 'boolean') return { ok: true, type: t, value: v };
  return { ok: true, type: t, opaque: true };
}

// Tek bir QuickJS modülü üzerinde mesaj işleyici. Worker da Node testi de bunu kullanır.
export function createHost(QuickJS) {
  const contexts = new Map();
  let tokenSeq = 0;

  function make(memoryMB, config = null) {
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(memoryMB * 1024 * 1024);
    rt.setMaxStackSize(1 << 20);
    let deadline = Date.now() + 5000;
    rt.setInterruptHandler(() => Date.now() > deadline);
    const vm = rt.newContext();

    // Kesilen (interrupt), belleği taşan ya da yığını patlayan çalıştırmalar QuickJS'te nesne artığı bırakabilir;
    // böyle bir runtime'ı serbest bırakmak assert ile tüm WASM modülünü düşürür.
    // shortcut: kirlenen runtime serbest bırakılmaz (en fazla memoryMB sızar); sızıntı büyürse worker'ı yeniden başlat.
    let tainted = false;
    const evalRaw = (src, ms) => {
      deadline = Date.now() + ms;
      let r;
      try {
        r = vm.evalCode(src);
      } catch (e) {
        // QuickJS regex motoru (ör. self-defending'in (((.+)+)+)+$ kalıbı) host yığınını taşırabilir
        tainted = true;
        return { ok: false, error: `host: ${e?.message ?? e}` };
      }
      if (r.error) {
        const e = vm.dump(r.error);
        r.error.dispose();
        const message = e?.message ?? String(e);
        if (/interrupted|out of memory|stack overflow/i.test(message)) tainted = true;
        return { ok: false, error: message };
      }
      const value = vm.dump(r.value);
      r.value.dispose();
      return { ok: true, value };
    };
    const dispose = () => {
      if (tainted) return;
      vm.dispose();
      rt.dispose();
    };

    // atob/btoa QuickJS'te yok: host'unkini bağla
    for (const name of ['atob', 'btoa']) {
      const fn = vm.newFunction(name, (x) => vm.newString(globalThis[name](String(vm.dump(x)))));
      vm.setProp(vm.global, name, fn);
      fn.dispose();
    }
    // Intl ve IANA saat dilimi verisi QuickJS'te yok: host Intl'ine senkron köprü (yalnızca string alır/verir)
    const bridges = { __peelHostIntl: hostIntl, __peelHostTz: (z, ms) => hostTzOffset(z, Number(ms)), __peelHostTzName: (z, ms) => hostTzName(z, Number(ms)) };
    for (const [name, f] of Object.entries(bridges)) {
      const fn = vm.newFunction(name, (...args) => vm.newString(f(...args.map((x) => String(vm.dump(x))))));
      vm.setProp(vm.global, name, fn);
      fn.dispose();
    }
    // sandbox yapılandırması (zaman, tarayıcı profili, çerez/depolama, sahte yanıtlar): stub'lar okur
    const c = evalRaw(`globalThis.__peelConfig = ${JSON.stringify(config ?? {})};`, 500);
    if (!c.ok) { dispose(); throw new Error(`config: ${c.error}`); }
    const s = evalRaw(STUBS, 2000);
    if (!s.ok) { dispose(); throw new Error(`stubs: ${s.error}`); }
    const sm = evalRaw(SEMANTIC_STUBS, 2000);
    if (!sm.ok) { dispose(); throw new Error(`semantic stubs: ${sm.error}`); }

    const readArray = (name, fallback = []) => {
      const r = evalRaw(`JSON.stringify(${name})`, 1000);
      return r.ok && typeof r.value === 'string' ? JSON.parse(r.value) : fallback;
    };
    // Promise geri çağrıları (fetch().then, async fonksiyonların devamı) ancak iş kuyruğu boşaltılınca çalışır
    const runJobs = (ms) => {
      deadline = Date.now() + ms;
      try {
        rt.executePendingJobs(5000).dispose();
      } catch {
        tainted = true;
      }
    };
    return { evalRaw, readArray, runJobs, dispose };
  }

  function withBox(memoryMB, config, fn) {
    const box = make(memoryMB, config);
    try { return fn(box); } finally { box.dispose(); }
  }

  function handle(msg) {
    const { type, code, list, token, timeoutMs = 4000, memoryMB = 64, config = null, post = null } = msg;

    switch (type) {
      case 'run':
        return withBox(memoryMB, config, (box) => {
          const r = box.evalRaw(`(function () {\n${code}\n})()`, timeoutMs);
          box.runJobs(Math.min(timeoutMs, 2000));
          // olay döngüsü modeli (E516/E517): her makro görevden önce mikro kuyruk boşaltılır, reddedilen sözler denetlenir
          if (config?.eventLoop) {
            for (let i = 0; i < 200; i++) {
              box.evalRaw('__peelProbe()', 500);
              box.runJobs(500);
              box.evalRaw('__peelCheck()', 500);
              const tick = box.evalRaw('__peelTick()', Math.min(timeoutMs, 2000));
              if (!tick.ok || tick.value !== true) break;
              box.runJobs(1000);
            }
          }
          // analiz: program bittikten sonra zamanlayıcılar/olay işleyicileri tetiklenir (davranış karşılaştırmasında yok)
          if (post) {
            box.evalRaw(post, 2000);
            box.runJobs(1000);
          }
          return {
            ok: r.ok, error: r.error, out: box.readArray('__out'), res: box.readArray('__res'),
            net: box.readArray('__peelNet'), reads: box.readArray('__peelReads', {}),
            crypto: post ? box.readArray('__peelCrypto') : [],
            sem: config?.eventLoop ? box.readArray('__peelSem') : [],
          };
        });

      case 'batch':
        return withBox(memoryMB, config, (box) => ({
          ok: true,
          results: list.map((expr) => decodeValue(box.evalRaw(VALUE_OF(expr), 500))),
        }));

      case 'open': {
        while (contexts.size >= MAX_CONTEXTS) {
          const [oldest] = contexts.keys();
          contexts.get(oldest).dispose();
          contexts.delete(oldest);
        }
        const box = make(96);
        // Global kapsamda çalıştır: üst seviye fonksiyon/değişkenler sonraki ifadelerden erişilebilir kalsın
        const r = box.evalRaw(code, timeoutMs);
        const id = `ctx${++tokenSeq}`;
        contexts.set(id, box);
        return { ok: true, token: id, runError: r.ok ? null : r.error };
      }

      case 'cbatch': {
        const box = contexts.get(token);
        if (!box) return { ok: false, error: 'bağlam yok' };
        return { ok: true, results: list.map((expr) => decodeValue(box.evalRaw(VALUE_OF(expr), 1500))) };
      }

      case 'close':
        contexts.get(token)?.dispose();
        contexts.delete(token);
        return { ok: true };

      default:
        return { ok: false, error: `bilinmeyen istek: ${type}` };
    }
  }

  return { handle };
}

// Worker istemcisi ve Node testinin paylaştığı API yüzeyi
export function sandboxApi(send) {
  return {
    run: (code, opts = {}) => send({ type: 'run', code, ...opts }),
    batch: (list, opts = {}) => send({ type: 'batch', list, ...opts }),
    open: (code, opts = {}) => send({ type: 'open', code, ...opts }),
    batchIn: (token, list) => send({ type: 'cbatch', token, list }),
    close: (token) => send({ type: 'close', token }),
  };
}
