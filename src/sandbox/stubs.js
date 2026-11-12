// QuickJS içinde çalışan sahte tarayıcı ortamı: ağ yok, gerçek DOM yok, zaman/rastgelelik sabit.
// __out: programın console çıktısı (davranış karşılaştırması). __res: pass'lerin kendi probe sonuçları.
export const STUBS = `
globalThis.__out = [];
globalThis.__res = [];
// __peelConfig: { now, seed, profile: { navigator, screen }, cookie, storage, responses: [{ match, status, body }] }
var __cfg = globalThis.__peelConfig || {};
// Kayıtlar (yalnızca analizde okunur): olay işleyicileri, setInterval geri çağrıları, kripto çağrıları
globalThis.__peelHandlers = [];
globalThis.__peelTimers = [];
globalThis.__peelCrypto = [];
function __peelOn(target, type, fn) {
  if (typeof fn === "function" && __peelHandlers.length < 300) __peelHandlers.push({ target: target, type: String(type), fn: fn });
}
(function () {
  var FIXED = typeof __cfg.now === "number" ? __cfg.now : 1700000000000;
  var RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [FIXED])); }
    static now() { return FIXED; }
  };
  var seed = typeof __cfg.seed === "number" ? __cfg.seed : 12345;
  Math.random = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
})();
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.top = globalThis;
globalThis.parent = globalThis;
globalThis.frames = globalThis;
globalThis.document = {
  cookie: String(__cfg.cookie || ""), referrer: "", title: "", readyState: "complete",
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {},
    addEventListener(t, f) { __peelOn(this, t, f); }, getContext: () => ({ fillRect() {}, drawImage() {}, fillText() {} }) }),
  getElementById: () => null, getElementsByClassName: () => [], getElementsByTagName: () => [],
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener(t, f) { __peelOn(document, t, f); }, removeEventListener() {},
  body: { appendChild() {}, style: {}, classList: { add() {}, remove() {} } },
  head: { appendChild() {} },
  documentElement: { style: {}, clientWidth: 1920, clientHeight: 1080 },
  createTextNode: () => ({}), createDocumentFragment: () => ({ appendChild() {} }),
};
globalThis.navigator = { userAgent: "Mozilla/5.0", language: "en-US", languages: ["en-US"],
  platform: "Win32", vendor: "", plugins: [], webdriver: false, cookieEnabled: true };
globalThis.location = { href: "https://example.com/", hostname: "example.com", protocol: "https:",
  pathname: "/", search: "", hash: "", origin: "https://example.com" };
globalThis.addEventListener = function (t, f) { __peelOn(globalThis, t, f); };
globalThis.removeEventListener = function () {};
globalThis.localStorage = { _d: Object.assign({}, __cfg.storage || {}), getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; } };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.setTimeout = (f) => { try { if (typeof f === "function") f(); } catch (e) {} return 0; };
globalThis.setInterval = (f) => { if (typeof f === "function" && __peelTimers.length < 100) __peelTimers.push(f); return 0; };
globalThis.clearTimeout = () => {};
globalThis.clearInterval = () => {};
globalThis.requestAnimationFrame = (f) => { try { f(0); } catch (e) {} return 0; };
globalThis.cancelAnimationFrame = () => {};
globalThis.console = {
  log(...a) {
    __out.push(a.map(x => {
      try { return typeof x === "object" && x !== null ? JSON.stringify(x) : String(x); }
      catch (e) { return String(x); }
    }).join(" "));
  },
  error(...a) { __out.push("!ERR " + a.map(String).join(" ")); },
  warn() {}, info() {}, debug() {}, trace() {}, table() {},
};
globalThis.alert = () => {};
globalThis.prompt = () => null;
globalThis.confirm = () => true;
globalThis.DOMParser = function () { this.parseFromString = () => ({ querySelectorAll: () => [], querySelector: () => null }); };
globalThis.crypto = {
  getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (i * 97 + 13) & 255; return a; },
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
  subtle: (function () {
    var buf = () => Promise.resolve(new ArrayBuffer(32));
    // girdi/çıktı kaydı: algoritma adı ve verinin ilk baytları (analiz raporu)
    function preview(d) {
      try {
        if (typeof d === "string") return d.slice(0, 64);
        var a = Array.from(new Uint8Array(d && d.buffer ? d.buffer : d || [])).slice(0, 32);
        return a.map(function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
      } catch (e) { return ""; }
    }
    function rec(op, alg, data, fn) {
      return function () {
        if (__peelCrypto.length < 200) __peelCrypto.push({ op: op, alg: String(alg && (alg.name || alg) || ""), data: preview(data) });
        return fn();
      };
    }
    var api = {};
    ["importKey", "exportKey", "digest", "encrypt", "decrypt", "sign", "verify", "generateKey", "deriveBits", "deriveKey"].forEach(function (op) {
      api[op] = function (a, b, c) {
        var alg = op === "importKey" || op === "exportKey" ? b : a;
        var data = op === "digest" ? b : op === "importKey" ? c : op === "encrypt" || op === "decrypt" || op === "sign" ? c : null;
        var result = op === "verify" ? () => Promise.resolve(true) : op === "importKey" || op === "generateKey" || op === "deriveKey" ? () => Promise.resolve({}) : buf;
        return rec(op, alg, data, result)();
      };
    });
    return api;
  })(),
};
globalThis.performance = { now: () => 0, timeOrigin: 1700000000000 };
globalThis.TextEncoder = function () { this.encode = (s) => Uint8Array.from(unescape(encodeURIComponent(String(s ?? ""))), (c) => c.charCodeAt(0)); };
globalThis.TextDecoder = function () { this.decode = (b) => decodeURIComponent(escape(String.fromCharCode.apply(null, Array.from(new Uint8Array(b && b.buffer ? b.buffer : b || []))))); };
// DOM kurucuları: koruma kodları prototype'larını dondurur/inceler; yoksa program erken çöker
(function () {
  var names = ["EventTarget", "Node", "Element", "HTMLElement", "HTMLCanvasElement", "HTMLImageElement",
    "HTMLInputElement", "HTMLIFrameElement", "HTMLScriptElement", "Document", "Event", "CustomEvent",
    "MutationObserver", "WebSocket", "Worker", "Blob", "File", "FileReader", "Image",
    "CanvasRenderingContext2D", "WebGLRenderingContext", "AudioContext", "OfflineAudioContext", "Notification"];
  names.forEach(function (n) {
    if (globalThis[n]) return;
    var C = function () {};
    C.prototype.addEventListener = function () {};
    C.prototype.getContext = function () { return { fillRect() {}, drawImage() {}, fillText() {}, getImageData: () => ({ data: [] }) }; };
    C.prototype.toDataURL = function () { return "data:,"; };
    globalThis[n] = C;
  });
  globalThis.URL = globalThis.URL || function (u) { this.href = String(u); };
})();
globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 };
globalThis.history = { length: 1, pushState() {}, replaceState() {} };

// Gözlem: kodun nereye istek atmaya çalıştığı ve hangi tarayıcı özelliklerini okuduğu (rapor için)
globalThis.__peelNet = [];
globalThis.__peelReads = {};
(function () {
  function count(key) { __peelReads[key] = (__peelReads[key] || 0) + 1; }
  function net(api, url, o) {
    if (__peelNet.length >= 500) return;
    __peelNet.push({ api: api, url: String(url && url.url || url || ""), method: (o && o.method) || "",
      body: o && o.body != null ? String(o.body).slice(0, 300) : "" });
  }
  function watch(name, obj) {
    return new Proxy(obj, { get: function (t, k, r) { if (typeof k === "string") count(name + "." + k); return Reflect.get(t, k, r); } });
  }
  // sahte yanıtlar: __cfg.responses içinde URL'si eşleşen ilk kayıt, yoksa boş 200
  function respond(url) {
    var u = String(url && url.url || url || "");
    var list = __cfg.responses || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].match && u.indexOf(list[i].match) >= 0) return list[i];
    return { status: 200, body: "" };
  }
  function response(url) {
    var r = respond(url), body = String(r.body == null ? "" : r.body);
    return { ok: (r.status || 200) < 400, status: r.status || 200, url: String(url && url.url || url || ""),
      text: () => Promise.resolve(body), json: () => Promise.resolve(body ? JSON.parse(body) : {}),
      headers: { get: () => null } };
  }
  globalThis.fetch = function (url, o) { net("fetch", url, { method: (o && o.method) || "GET", body: o && o.body }); return Promise.resolve(response(url)); };
  globalThis.XMLHttpRequest = function () {
    var m = "GET", u = "";
    var self = this;
    this.readyState = 0;
    this.open = function (a, b) { m = a; u = b; self.readyState = 1; };
    this.send = function (b) {
      net("xhr", u, { method: m, body: b });
      var r = response(u);
      self.readyState = 4; self.status = r.status; self.responseText = self.response = "";
      r.text().then(function (t) { self.responseText = self.response = t; });
    };
    this.setRequestHeader = function () {};
    this.addEventListener = function (t, f) { __peelOn(self, t, f); };
  };
  globalThis.WebSocket = function (u) {
    net("websocket", u);
    this.send = function (d) { net("websocket.send", u, { body: d }); };
    this.close = function () {};
    this.addEventListener = function () {};
  };
  navigator.sendBeacon = function (u, d) { net("beacon", u, { method: "POST", body: d }); return true; };
  function Img() {}
  Object.defineProperty(Img.prototype, "src", { set: function (v) { net("image", v); this._src = v; }, get: function () { return this._src || ""; } });
  globalThis.Image = Img;
  var create = document.createElement;
  document.createElement = function (tag) {
    var el = create(tag), src = "", kind = String(tag).toLowerCase() === "script" ? "script" : "element";
    Object.defineProperty(el, "src", { set: function (v) { src = v; net(kind, v); }, get: function () { return src; } });
    el.toDataURL = function () { count("canvas.toDataURL"); return "data:,"; };
    return el;
  };
  globalThis.document = watch("document", document);
  globalThis.navigator = watch("navigator", navigator);
  globalThis.screen = watch("screen", screen);
  // yönlendirme: location.href = …, assign/replace, window.open
  location.assign = function (u) { net("navigate", u); };
  location.replace = function (u) { net("navigate", u); };
  location.reload = function () {};
  globalThis.open = function (u) { net("window.open", u); return null; };
  globalThis.location = new Proxy(location, {
    get: function (t, k, r) { if (typeof k === "string") count("location." + k); return Reflect.get(t, k, r); },
    set: function (t, k, v) { if (k === "href") net("navigate", v); t[k] = v; return true; },
  });
  // tarayıcı profili: navigator/screen alanlarının üzerine yazılır (bot ve gerçek kullanıcı karşılaştırması)
  var prof = __cfg.profile || {};
  Object.assign(navigator, prof.navigator || {});
  Object.assign(screen, prof.screen || {});
})();
globalThis.__peelBaseGlobals = Object.getOwnPropertyNames(globalThis);
`;
