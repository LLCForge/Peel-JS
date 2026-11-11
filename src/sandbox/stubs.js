// QuickJS içinde çalışan sahte tarayıcı ortamı: ağ yok, gerçek DOM yok, zaman/rastgelelik sabit.
// __out: programın console çıktısı (davranış karşılaştırması). __res: pass'lerin kendi probe sonuçları.
export const STUBS = `
globalThis.__out = [];
globalThis.__res = [];
(function () {
  var FIXED = 1700000000000;
  var RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [FIXED])); }
    static now() { return FIXED; }
  };
  var seed = 12345;
  Math.random = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
})();
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.top = globalThis;
globalThis.parent = globalThis;
globalThis.frames = globalThis;
globalThis.document = {
  cookie: "", referrer: "", title: "", readyState: "complete",
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {},
    addEventListener() {}, getContext: () => ({ fillRect() {}, drawImage() {}, fillText() {} }) }),
  getElementById: () => null, getElementsByClassName: () => [], getElementsByTagName: () => [],
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  body: { appendChild() {}, style: {}, classList: { add() {}, remove() {} } },
  head: { appendChild() {} },
  documentElement: { style: {}, clientWidth: 1920, clientHeight: 1080 },
  createTextNode: () => ({}), createDocumentFragment: () => ({ appendChild() {} }),
};
globalThis.navigator = { userAgent: "Mozilla/5.0", language: "en-US", languages: ["en-US"],
  platform: "Win32", vendor: "", plugins: [], webdriver: false, cookieEnabled: true };
globalThis.location = { href: "https://example.com/", hostname: "example.com", protocol: "https:",
  pathname: "/", search: "", hash: "", origin: "https://example.com" };
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; } };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.setTimeout = (f) => { try { if (typeof f === "function") f(); } catch (e) {} return 0; };
globalThis.setInterval = () => 0;
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
    return { importKey: () => Promise.resolve({}), exportKey: buf, digest: buf, encrypt: buf, decrypt: buf,
      sign: buf, verify: () => Promise.resolve(true), generateKey: () => Promise.resolve({}), deriveBits: buf, deriveKey: () => Promise.resolve({}) };
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
  var okResponse = { ok: true, status: 200, text: () => Promise.resolve(""), json: () => Promise.resolve({}) };
  globalThis.fetch = function (url, o) { net("fetch", url, { method: (o && o.method) || "GET", body: o && o.body }); return Promise.resolve(okResponse); };
  globalThis.XMLHttpRequest = function () {
    var m = "GET", u = "";
    this.open = function (a, b) { m = a; u = b; };
    this.send = function (b) { net("xhr", u, { method: m, body: b }); };
    this.setRequestHeader = function () {};
    this.addEventListener = function () {};
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
  globalThis.location = watch("location", location);
})();
`;
