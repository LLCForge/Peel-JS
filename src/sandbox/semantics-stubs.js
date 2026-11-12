// Sandbox semantik modelleri (E516–E519, E529–E531, E534, E539, E540). STUBS'tan sonra yüklenir.
// QuickJS'te olmayan ya da host'a bağlı (saat dilimi) davranışlar tarayıcı (V8) semantiğine göre, deterministik kurulur.
// __peelConfig: { tz: dakika (getTimezoneOffset değeri, varsayılan 0), perfStep: ms (varsayılan 1),
//                 locale: varsayılan yerel ayar, eventLoop: true → kuyruk tabanlı olay döngüsü + kayıt (__peelSem) }
export const SEMANTIC_STUBS = `
(function () {
  var cfg = globalThis.__peelConfig || {};
  var semOn = cfg.eventLoop === true;
  var sem = globalThis.__peelSem = [];
  function log(o) { if (semOn && sem.length < 500) sem.push(o); }
  function fname(f) { try { return (f && f.name) || "anonim"; } catch (e) { return "?"; } }

  // ---------------------------------------------------------------- E534 performance.now: monoton, deterministik
  var perfT = 0, perfStep = typeof cfg.perfStep === "number" && cfg.perfStep > 0 ? cfg.perfStep : 1;
  if (globalThis.performance) globalThis.performance.now = function now() { perfT += perfStep; return perfT; };

  // ---------------------------------------------------------------- E529 saat dilimi
  var TZ = typeof cfg.tz === "number" && isFinite(cfg.tz) ? Math.trunc(cfg.tz) : 0;
  var StubDate = globalThis.Date, NativeDate = Object.getPrototypeOf(StubDate);
  var N = NativeDate.prototype;
  var getTime = function (d) { return N.getTime.call(d); };
  var wall = function (t) { return new NativeDate(t - TZ * 60000); };
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var pad = function (n, w) { var s = String(Math.abs(n)); while (s.length < (w || 2)) s = "0" + s; return (n < 0 ? "-" : "") + s; };
  function zoneText() {
    var off = -TZ, sign = off < 0 ? "-" : "+", a = Math.abs(off);
    var hhmm = pad(Math.floor(a / 60)) + pad(a % 60);
    return "GMT" + sign + hhmm + " (" + (TZ === 0 ? "Coordinated Universal Time" : "GMT" + sign + pad(Math.floor(a / 60)) + ":" + pad(a % 60)) + ")";
  }
  function yearText(y) { return y < 0 ? "-" + pad(-y, 6) : pad(y, 4); }
  var LOCAL = { FullYear: "getUTCFullYear", Month: "getUTCMonth", Date: "getUTCDate", Day: "getUTCDay", Hours: "getUTCHours",
    Minutes: "getUTCMinutes", Seconds: "getUTCSeconds", Milliseconds: "getUTCMilliseconds" };
  var P = StubDate.prototype;
  Object.keys(LOCAL).forEach(function (k) {
    var utc = N[LOCAL[k]];
    Object.defineProperty(P, "get" + k, { configurable: true, writable: true, value: function () {
      var t = getTime(this); return t !== t ? NaN : utc.call(wall(t));
    } });
  });
  Object.defineProperty(P, "getYear", { configurable: true, writable: true, value: function () { var y = this.getFullYear(); return y !== y ? NaN : y - 1900; } });
  Object.defineProperty(P, "getTimezoneOffset", { configurable: true, writable: true, value: function () { var t = getTime(this); return t !== t ? NaN : TZ; } });
  ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"].forEach(function (k) {
    var setUTC = N["setUTC" + k];
    Object.defineProperty(P, "set" + k, { configurable: true, writable: true, value: function () {
      var t = getTime(this);
      if (t !== t && k !== "FullYear") { N.setTime.call(this, NaN); return NaN; }
      var w = wall(t !== t ? TZ * 60000 : t);
      var r = setUTC.apply(w, arguments);
      return N.setTime.call(this, r !== r ? NaN : r + TZ * 60000);
    } });
  });
  Object.defineProperty(P, "setYear", { configurable: true, writable: true, value: function (y) {
    y = Number(y); if (y === y && y >= 0 && y <= 99) y += 1900; return this.setFullYear(y);
  } });
  function dateText(d) { var w = wall(getTime(d)); return DAYS[N.getUTCDay.call(w)] + " " + MONTHS[N.getUTCMonth.call(w)] + " " + pad(N.getUTCDate.call(w)) + " " + yearText(N.getUTCFullYear.call(w)); }
  function timeText(d) { var w = wall(getTime(d)); return pad(N.getUTCHours.call(w)) + ":" + pad(N.getUTCMinutes.call(w)) + ":" + pad(N.getUTCSeconds.call(w)) + " " + zoneText(); }
  var invalid = function (d) { var t = getTime(d); return t !== t; };
  Object.defineProperty(P, "toString", { configurable: true, writable: true, value: function toString() { return invalid(this) ? "Invalid Date" : dateText(this) + " " + timeText(this); } });
  Object.defineProperty(P, "toDateString", { configurable: true, writable: true, value: function toDateString() { return invalid(this) ? "Invalid Date" : dateText(this); } });
  Object.defineProperty(P, "toTimeString", { configurable: true, writable: true, value: function toTimeString() { return invalid(this) ? "Invalid Date" : timeText(this); } });

  var EXPLICIT_ZONE = /(Z|[+-]\\d{2}:?\\d{2}|\\b(GMT|UTC|UT)\\b[^)]*)\\s*(\\(.*\\))?\\s*$/i;
  var DATE_ONLY = /^\\s*[+-]?\\d{4,6}(-\\d\\d(-\\d\\d)?)?\\s*$/;
  function parseDate(s) {
    s = String(s);
    var host = NativeDate.parse(s);
    if (host !== host || EXPLICIT_ZONE.test(s) || DATE_ONLY.test(s)) return host;
    // host yerel saatiyle yorumlandı: duvar saatine çevir, modeldeki dilime yerleştir
    var hostOff = N.getTimezoneOffset.call(new NativeDate(host));
    return host - hostOff * 60000 + TZ * 60000;
  }
  function D() {
    var a = Array.prototype.slice.call(arguments);
    if (!new.target) return new D().toString();
    if (a.length >= 2) {
      var n = a.map(Number);
      var y = n[0]; if (y === y && Math.trunc(y) >= 0 && Math.trunc(y) <= 99) y = 1900 + Math.trunc(y);
      var u = NativeDate.UTC(y, n[1], n.length > 2 ? n[2] : 1, n.length > 3 ? n[3] : 0, n.length > 4 ? n[4] : 0, n.length > 5 ? n[5] : 0, n.length > 6 ? n[6] : 0);
      a = [u !== u ? NaN : u + TZ * 60000];
    } else if (a.length === 1 && typeof a[0] === "string") a = [parseDate(a[0])];
    return Reflect.construct(StubDate, a, new.target);
  }
  Object.setPrototypeOf(D, StubDate);
  D.prototype = P;
  Object.defineProperty(P, "constructor", { configurable: true, writable: true, value: D });
  Object.defineProperty(D, "parse", { configurable: true, writable: true, value: function parse(s) { return parseDate(s); } });
  Object.defineProperty(D, "length", { value: 7 });
  Object.defineProperty(D, "name", { value: "Date" });
  globalThis.Date = D;

  // ---------------------------------------------------------------- E531 Intl.NumberFormat (yerel ayar tablosu)
  var NBSP = "\\u00a0", NNBSP = "\\u202f";
  var LOCALES = {
    en: { tag: "en-US", group: ",", decimal: ".", cur: "pre", pct: "post", sym: { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "CN¥", INR: "₹", CAD: "CA$", AUD: "A$" } },
    tr: { tag: "tr-TR", group: ".", decimal: ",", cur: "pre", pct: "pre", sym: { TRY: "₺", USD: "$", EUR: "€", GBP: "£", JPY: "¥" } },
    de: { tag: "de-DE", group: ".", decimal: ",", cur: "post", pct: "post-space", sym: { EUR: "€", USD: "$", GBP: "£", JPY: "¥" } },
    fr: { tag: "fr-FR", group: NNBSP, decimal: ",", cur: "post", pct: "post-narrow", sym: { EUR: "€", USD: "$US", GBP: "£GB", JPY: "JPY" } },
    ru: { tag: "ru-RU", group: NBSP, decimal: ",", cur: "post", pct: "post-space", sym: { RUB: "₽", USD: "$", EUR: "€" } },
    ja: { tag: "ja-JP", group: ",", decimal: ".", cur: "pre", pct: "post", sym: { JPY: "￥", USD: "$", EUR: "€" } },
  };
  var CUR_DIGITS = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 2, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };
  var COMPACT_EN = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  function canonical(tag) {
    var parts = String(tag).split(/[-_]/);
    if (!/^[a-z]{2,3}$/i.test(parts[0])) throw new RangeError("Incorrect locale information provided");
    return parts.map(function (p, i) { return i === 0 ? p.toLowerCase() : p.length === 2 ? p.toUpperCase() : p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toLowerCase(); }).join("-");
  }
  function localeList(locales) {
    if (locales === undefined) return [];
    var list = typeof locales === "string" ? [locales] : Array.prototype.slice.call(Object(locales));
    return list.map(canonical);
  }
  function defaultLocale() {
    // navigator izlenen bir Proxy: okumak rapordaki "okunan özellikler"i kirletir, profil yapılandırmasından alınır
    var l = cfg.locale || (cfg.profile && cfg.profile.navigator && cfg.profile.navigator.language) || "en-US";
    try { return canonical(l); } catch (e) { return "en-US"; }
  }
  function resolveLocale(locales) {
    var list = localeList(locales).concat([defaultLocale(), "en-US"]);
    for (var i = 0; i < list.length; i++) {
      var lang = list[i].split("-")[0];
      if (LOCALES[lang]) return { data: LOCALES[lang], locale: list[i].split("-").length > 1 && i < list.length - 1 ? list[i] : LOCALES[lang].tag };
    }
    return { data: LOCALES.en, locale: "en-US" };
  }
  function opt(o, k, allowed, def) {
    var v = o[k];
    if (v === undefined) return def;
    v = String(v);
    if (allowed && allowed.indexOf(v) < 0) throw new RangeError("Value " + v + " out of range for Intl.NumberFormat options property " + k);
    return v;
  }
  function num(o, k, min, max, def) {
    var v = o[k];
    if (v === undefined) return def;
    v = Number(v);
    if (v !== v || v < min || v > max) throw new RangeError(k + " value is out of range.");
    return Math.floor(v);
  }
  function NumberFormat(locales, options) {
    if (!new.target) return new NumberFormat(locales, options);
    var o = options === undefined ? {} : Object(options);
    var loc = resolveLocale(locales);
    var style = opt(o, "style", ["decimal", "percent", "currency", "unit"], "decimal");
    if (style === "unit") throw new RangeError("PEEL sandbox: Intl.NumberFormat unit stili modellenmedi");
    var currency = o.currency === undefined ? undefined : String(o.currency).toUpperCase();
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new RangeError("Invalid currency code : " + o.currency);
    if (style === "currency" && currency === undefined) throw new TypeError("Currency code is required with currency style.");
    var currencyDisplay = opt(o, "currencyDisplay", ["code", "symbol", "narrowSymbol", "name"], "symbol");
    var notation = opt(o, "notation", ["standard", "scientific", "engineering", "compact"], "standard");
    if (notation === "scientific" || notation === "engineering") throw new RangeError("PEEL sandbox: " + notation + " gösterimi modellenmedi");
    if (notation === "compact" && loc.data !== LOCALES.en) throw new RangeError("PEEL sandbox: compact gösterim yalnızca en için modellendi");
    var cd = style === "currency" ? (Object.prototype.hasOwnProperty.call(CUR_DIGITS, currency) ? CUR_DIGITS[currency] : 2) : 0;
    var minInt = num(o, "minimumIntegerDigits", 1, 21, 1);
    var minSig = num(o, "minimumSignificantDigits", 1, 21, undefined);
    var maxSig = num(o, "maximumSignificantDigits", minSig || 1, 21, undefined);
    if (minSig !== undefined && maxSig === undefined) maxSig = 21;
    if (maxSig !== undefined && minSig === undefined) minSig = 1;
    var minFD = num(o, "minimumFractionDigits", 0, 100, undefined);
    var maxFD = num(o, "maximumFractionDigits", 0, 100, undefined);
    var defMin = style === "currency" ? cd : 0, defMax = style === "currency" ? Math.max(cd, minFD || 0) : style === "percent" ? Math.max(0, minFD || 0) : Math.max(3, minFD || 0);
    if (minFD === undefined) minFD = Math.min(defMin, maxFD === undefined ? defMin : maxFD);
    if (maxFD === undefined) maxFD = Math.max(defMax, minFD);
    if (minFD > maxFD) throw new RangeError("maximumFractionDigits value is out of range.");
    var ug = o.useGrouping;
    var useGrouping = ug === undefined ? (notation === "compact" ? "min2" : "auto") : ug === false || ug === "false" ? false : ug === true || ug === "true" ? "always" : String(ug);
    var signDisplay = opt(o, "signDisplay", ["auto", "never", "always", "exceptZero", "negative"], "auto");
    var compactDisplay = opt(o, "compactDisplay", ["short", "long"], "short");
    this.__s = { loc: loc, style: style, currency: currency, currencyDisplay: currencyDisplay, notation: notation, minInt: minInt, minSig: minSig, maxSig: maxSig,
      minFD: minFD, maxFD: maxFD, useGrouping: useGrouping, signDisplay: signDisplay, compactDisplay: compactDisplay,
      explicitDigits: o.minimumFractionDigits !== undefined || o.maximumFractionDigits !== undefined || minSig !== undefined };
    Object.defineProperty(this, "__s", { enumerable: false });
  }
  // Sayının en kısa ondalık gösterimi (ICU/V8 Intl yuvarlamayı bu basamaklar üzerinde yapar: 1.005 → "1.01")
  function exact(x) {
    var m = String(x).match(/^([0-9]+)(?:[.]([0-9]+))?(?:e([-+][0-9]+))?$/);
    var all = m[1] + (m[2] || ""), point = m[1].length + (m[3] ? Number(m[3]) : 0);
    if (point <= 0) return { int: "0", frac: ("0".repeat(-point) + all).replace(/0+$/, "") };
    if (point >= all.length) return { int: (all + "0".repeat(point - all.length)).replace(/^0+(?=[0-9])/, ""), frac: "" };
    return { int: all.slice(0, point).replace(/^0+(?=[0-9])/, ""), frac: all.slice(point).replace(/0+$/, "") };
  }
  function incr(s) {
    var a = s.split(""), i = a.length - 1;
    for (; i >= 0; i--) { if (a[i] === "9") a[i] = "0"; else { a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1); break; } }
    if (i < 0) a.unshift("1");
    return a.join("");
  }
  // yarı uzağa (halfExpand) yuvarlama, f kesir basamağı (negatifse tam sayı kısmında)
  function roundFrac(ex, f) {
    if (f < 0) {
      var k = -f, int0 = ex.int, keepLen = int0.length - k;
      if (keepLen < 0) return { int: "0", frac: "" };
      var head = int0.slice(0, keepLen) || "0";
      if (int0.charCodeAt(keepLen) >= 53) head = incr(head);
      return { int: (head + "0".repeat(k)).replace(/^0+(?=[0-9])/, ""), frac: "" };
    }
    if (ex.frac.length <= f) return { int: ex.int, frac: ex.frac + "0".repeat(f - ex.frac.length) };
    var s = ex.int + ex.frac.slice(0, f);
    if (ex.frac.charCodeAt(f) >= 53) s = incr(s);
    var intLen = s.length - f;
    return { int: s.slice(0, intLen) || "0", frac: s.slice(intLen) };
  }
  // shift: ondalık noktayı sola kaydırır (compact ölçekleme tam değer üzerinde yapılır)
  function digits(x, s, shift) {
    var ex = exact(x), r;
    if (shift) {
      var all = ex.int;
      while (all.length <= shift) all = "0" + all;
      ex = { int: all.slice(0, all.length - shift), frac: (all.slice(all.length - shift) + ex.frac).replace(/0+$/, "") };
    }
    if (s.minSig !== undefined) {
      if (x === 0) r = { int: "0", frac: s.minSig > 1 ? "0".repeat(s.minSig - 1) : "" };
      else {
        var intDigits = ex.int.replace(/^0+/, "").length;
        var mag = intDigits ? intDigits : -(ex.frac.match(/^0*/)[0].length);
        r = roundFrac(ex, s.maxSig - mag);
        var count = function (q) { return (q.int + q.frac).replace(/^0+/, "").length; };
        while (r.frac.length && r.frac.slice(-1) === "0" && count(r) > s.minSig) r.frac = r.frac.slice(0, -1);
      }
    } else {
      r = roundFrac(ex, s.maxFD);
      while (r.frac.length > s.minFD && r.frac.slice(-1) === "0") r.frac = r.frac.slice(0, -1);
    }
    var int = r.int;
    while (int.length < s.minInt) int = "0" + int;
    return { int: int, frac: r.frac };
  }
  function group(int, s) {
    var g = s.useGrouping;
    if (g === false || int.length < 4) return [int];
    if (g === "min2" && int.length < 5) return [int];
    var out = [], i = int.length % 3 || 3;
    out.push(int.slice(0, i));
    for (; i < int.length; i += 3) out.push(int.slice(i, i + 3));
    return out;
  }
  function parts(nf, value) {
    var s = nf.__s, d = s.loc.data, out = [];
    var big = typeof value === "bigint";
    var x = big ? value : Number(value);
    var neg = big ? x < 0n : (x < 0 || Object.is(x, -0));
    var abs = big ? (neg ? -x : x) : Math.abs(x);
    if (!big && s.style === "percent") abs = abs * 100;
    var isZero = big ? abs === 0n : abs === 0;
    var sign = "";
    if (s.signDisplay === "auto") sign = neg && !(isZero && !Object.is(x, -0) && !big) ? "-" : "";
    else if (s.signDisplay === "always") sign = neg ? "-" : "+";
    else if (s.signDisplay === "exceptZero") sign = isZero ? "" : neg ? "-" : "+";
    else if (s.signDisplay === "negative") sign = neg && !isZero ? "-" : "";
    var body = [];
    if (!big && abs !== abs) body.push({ type: "nan", value: "NaN" });
    else if (!big && abs === Infinity) body.push({ type: "infinity", value: "∞" });
    else {
      var compact = "", pre = null;
      if (s.notation === "compact" && !big) {
        for (var i = 0; i < COMPACT_EN.length; i++) {
          // 999.5 → yuvarlanınca 1000 olur: bir üst birime geçer
          if (abs >= COMPACT_EN[i][0] - 0.5 * COMPACT_EN[i][0] / 1000) {
            var shift = 3 * (COMPACT_EN.length - i);
            var st = s.explicitDigits ? s : { minInt: 1, minSig: 1, maxSig: 2, minFD: 0, maxFD: 0 };
            if (!s.explicitDigits && abs / COMPACT_EN[i][0] >= 100) st = { minInt: 1, minFD: 0, maxFD: 0 };
            pre = digits(abs, st, shift);
            compact = s.compactDisplay === "long" ? " " + ["trillion", "billion", "million", "thousand"][i] : COMPACT_EN[i][1];
            break;
          }
        }
        if (!compact && !s.explicitDigits) pre = digits(abs, abs >= 100 ? { minInt: s.minInt, minFD: 0, maxFD: 0 } : { minInt: s.minInt, minSig: 1, maxSig: 2 });
      }
      var dgt = big ? { int: abs.toString(), frac: s.minFD ? "0".repeat(s.minFD) : "" } : pre || digits(abs, s);
      if (big) while (dgt.int.length < s.minInt) dgt.int = "0" + dgt.int;
      var gs = group(dgt.int, s);
      gs.forEach(function (g, k) { if (k) body.push({ type: "group", value: d.group }); body.push({ type: "integer", value: g }); });
      if (dgt.frac) { body.push({ type: "decimal", value: d.decimal }); body.push({ type: "fraction", value: dgt.frac }); }
      if (compact) body.push({ type: "compact", value: compact.trim() === compact ? compact : compact.trim() });
      if (compact && compact[0] === " ") body.splice(body.length - 1, 0, { type: "literal", value: " " });
    }
    var signPart = sign ? [{ type: sign === "-" ? "minusSign" : "plusSign", value: sign }] : [];
    if (s.style === "percent") {
      var pc = { type: "percentSign", value: "%" };
      if (d.pct === "pre") out = signPart.concat([pc], body);
      else if (d.pct === "post-space") out = signPart.concat(body, [{ type: "literal", value: NBSP }, pc]);
      else if (d.pct === "post-narrow") out = signPart.concat(body, [{ type: "literal", value: NNBSP }, pc]);
      else out = signPart.concat(body, [pc]);
    } else if (s.style === "currency") {
      var symbol = s.currencyDisplay === "code" ? s.currency : (d.sym[s.currency] || s.currency);
      if (s.currencyDisplay === "narrowSymbol") symbol = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", TRY: "₺", RUB: "₽", INR: "₹", CNY: "¥" }[s.currency] || symbol;
      if (s.currencyDisplay === "name") return signPart.concat(body, [{ type: "literal", value: " " }, { type: "currency", value: s.currency }]);
      var cp = { type: "currency", value: symbol };
      var spaced = /^[A-Z]{3}$/.test(symbol) || /[A-Z]$/.test(symbol);
      if (d.cur === "pre") out = signPart.concat([cp], spaced ? [{ type: "literal", value: NBSP }] : [], body);
      else out = signPart.concat(body, [{ type: "literal", value: NBSP }, cp]);
    } else out = signPart.concat(body);
    return out;
  }
  Object.defineProperty(NumberFormat.prototype, "format", { configurable: true, get: function () {
    var self = this;
    if (!self || !self.__s) throw new TypeError("Method get Intl.NumberFormat.prototype.format called on incompatible receiver");
    return function (v) { log({ k: "intl", api: "NumberFormat.format" }); return parts(self, typeof v === "bigint" ? v : Number(v)).map(function (p) { return p.value; }).join(""); };
  } });
  NumberFormat.prototype.formatToParts = function formatToParts(v) { return parts(this, typeof v === "bigint" ? v : Number(v)); };
  NumberFormat.prototype.resolvedOptions = function resolvedOptions() {
    var s = this.__s, r = { locale: s.loc.locale, numberingSystem: "latn", style: s.style };
    if (s.style === "currency") { r.currency = s.currency; r.currencyDisplay = s.currencyDisplay; r.currencySign = "standard"; }
    r.minimumIntegerDigits = s.minInt;
    if (s.minSig !== undefined) { r.minimumSignificantDigits = s.minSig; r.maximumSignificantDigits = s.maxSig; }
    else { r.minimumFractionDigits = s.minFD; r.maximumFractionDigits = s.maxFD; }
    r.useGrouping = s.useGrouping; r.notation = s.notation;
    if (s.notation === "compact") r.compactDisplay = s.compactDisplay;
    r.signDisplay = s.signDisplay; r.roundingIncrement = 1; r.roundingMode = "halfExpand"; r.roundingPriority = "auto"; r.trailingZeroDisplay = "auto";
    return r;
  };
  Object.defineProperty(NumberFormat.prototype, Symbol.toStringTag, { value: "Intl.NumberFormat", configurable: true });
  NumberFormat.supportedLocalesOf = function supportedLocalesOf(l) { return localeList(l).filter(function (x) { return Boolean(LOCALES[x.split("-")[0]]); }); };
  if (!globalThis.Intl) {
    var Intl = {};
    Object.defineProperty(Intl, Symbol.toStringTag, { value: "Intl", configurable: true });
    Intl.NumberFormat = NumberFormat;
    Intl.getCanonicalLocales = function getCanonicalLocales(l) { return localeList(l).filter(function (x, i, a) { return a.indexOf(x) === i; }); };
    globalThis.Intl = Intl;
  }

  // ---------------------------------------------------------------- E530 toLocaleString
  Number.prototype.toLocaleString = function toLocaleString(l, o) {
    var v = Number.prototype.valueOf.call(this);
    return new NumberFormat(l, o).format(v);
  };
  if (typeof BigInt === "function") BigInt.prototype.toLocaleString = function toLocaleString(l, o) { return new NumberFormat(l, o).format(BigInt.prototype.valueOf.call(this)); };
  Array.prototype.toLocaleString = function toLocaleString(l, o) {
    var a = Object(this), n = a.length >>> 0, out = [];
    for (var i = 0; i < n; i++) { var e = a[i]; out.push(e === undefined || e === null ? "" : String(e.toLocaleString(l, o))); }
    return out.join(",");
  };
  // tarih biçimleri: yerel ayarın varsayılan (seçeneksiz) kalıbı; timeZone: "UTC" ve hour12 desteklenir
  var DATE_FMT = {
    en: function (f) { return [f.M + "/" + f.D + "/" + f.Y, f.h12 + ":" + pad(f.m) + ":" + pad(f.s) + " " + f.ap, ", "]; },
    tr: function (f) { return [pad(f.D) + "." + pad(f.M) + "." + f.Y, pad(f.H) + ":" + pad(f.m) + ":" + pad(f.s), " "]; },
    de: function (f) { return [f.D + "." + f.M + "." + f.Y, pad(f.H) + ":" + pad(f.m) + ":" + pad(f.s), ", "]; },
    fr: function (f) { return [pad(f.D) + "/" + pad(f.M) + "/" + f.Y, pad(f.H) + ":" + pad(f.m) + ":" + pad(f.s), " "]; },
    ru: function (f) { return [pad(f.D) + "." + pad(f.M) + "." + f.Y, pad(f.H) + ":" + pad(f.m) + ":" + pad(f.s), ", "]; },
    ja: function (f) { return [f.Y + "/" + f.M + "/" + f.D, f.H + ":" + pad(f.m) + ":" + pad(f.s), " "]; },
  };
  function dateFields(d, o) {
    var t = getTime(d);
    var utc = o && o.timeZone !== undefined && /^(utc|etc\\/utc|gmt)$/i.test(String(o.timeZone));
    if (o && o.timeZone !== undefined && !utc) throw new RangeError("PEEL sandbox: timeZone " + o.timeZone + " modellenmedi");
    var w = new NativeDate(utc ? t : t - TZ * 60000);
    var H = N.getUTCHours.call(w);
    return { Y: N.getUTCFullYear.call(w), M: N.getUTCMonth.call(w) + 1, D: N.getUTCDate.call(w), H: H, m: N.getUTCMinutes.call(w), s: N.getUTCSeconds.call(w),
      h12: H % 12 === 0 ? 12 : H % 12, ap: H < 12 ? "AM" : "PM" };
  }
  function dateLocale(d, l, o, which) {
    log({ k: "intl", api: "Date." + which });
    if (invalid(d)) return "Invalid Date";
    var lang = resolveLocale(l).locale.split("-")[0];
    var f = dateFields(d, o);
    var r = DATE_FMT[lang](f);
    if (o && o.hour12 !== undefined) r[1] = o.hour12 ? f.h12 + ":" + pad(f.m) + ":" + pad(f.s) + " " + f.ap : pad(f.H) + ":" + pad(f.m) + ":" + pad(f.s);
    return which === "date" ? r[0] : which === "time" ? r[1] : r[0] + r[2] + r[1];
  }
  Object.defineProperty(P, "toLocaleString", { configurable: true, writable: true, value: function toLocaleString(l, o) { return dateLocale(this, l, o, "both"); } });
  Object.defineProperty(P, "toLocaleDateString", { configurable: true, writable: true, value: function toLocaleDateString(l, o) { return dateLocale(this, l, o, "date"); } });
  Object.defineProperty(P, "toLocaleTimeString", { configurable: true, writable: true, value: function toLocaleTimeString(l, o) { return dateLocale(this, l, o, "time"); } });

  // ---------------------------------------------------------------- E519 Error.captureStackTrace / stackTraceLimit (V8)
  var RealError = Error;
  if (!("stackTraceLimit" in RealError)) RealError.stackTraceLimit = 10;
  function frames(skipName) {
    var raw = String(new RealError().stack || "").split("\\n").filter(function (l) { return /^\\s*at /.test(l); });
    raw = raw.filter(function (l) { return !/at (captureStackTrace|__peel\\w*|frames|v8Stack) |\\(native\\)/.test(l); });
    if (skipName) {
      var i = raw.findIndex(function (l) { return l.indexOf("at " + skipName + " ") >= 0; });
      if (i >= 0) raw = raw.slice(i + 1);
    }
    var lim = RealError.stackTraceLimit;
    if (typeof lim !== "number") return null;
    return raw.slice(0, Math.max(0, lim));
  }
  function header(e) {
    var n = e.name === undefined ? "Error" : String(e.name), m = e.message === undefined ? "" : String(e.message);
    return n && m ? n + ": " + m : n || m;
  }
  Object.defineProperty(RealError, "captureStackTrace", { configurable: true, writable: true, value: function captureStackTrace(obj, ctor) {
    if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) throw new TypeError("Invalid argument");
    var f = frames(typeof ctor === "function" ? ctor.name : null);
    if (f === null) return undefined;
    var text = header(obj) + (f.length ? "\\n" + f.join("\\n") : "");
    log({ k: "stack", api: "captureStackTrace", frames: f.length });
    Object.defineProperty(obj, "stack", { configurable: true, writable: true, enumerable: false, value: text });
    return undefined;
  } });
  // E518: analiz çalıştırmasında kurucuyla yaratılan hataların stack'i V8 biçimine (başlık satırı + çerçeve sınırı) getirilir ve okumalar kaydedilir
  if (semOn) {
    ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"].forEach(function (name) {
      var C = globalThis[name];
      function v8Stack(e) {
        var f = frames(null) || [];
        var text = header(e) + (f.length ? "\\n" + f.join("\\n") : "");
        Object.defineProperty(e, "stack", { configurable: true, enumerable: false, get: function () { log({ k: "stack", api: name + ".stack" }); return text; }, set: function (v) { text = v; } });
        return e;
      }
      globalThis[name] = new Proxy(C, {
        construct: function __peelErrConstruct(tg, args, nt) { return v8Stack(Reflect.construct(tg, args, nt)); },
        apply: function __peelErrApply(tg, self, args) { return v8Stack(Reflect.construct(tg, args)); },
      });
    });
  }

  // ---------------------------------------------------------------- E539 Atomics (tek ajan, ana iş parçacığı)
  if (typeof globalThis.Atomics === "undefined") {
    var INT_TYPES = ["Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array"];
    var waiters = [];
    function check(ta, waitable) {
      var tag = ta && Object.prototype.toString.call(ta).slice(8, -1);
      if (!ta || INT_TYPES.indexOf(tag) < 0 || (waitable && tag !== "Int32Array" && tag !== "BigInt64Array")) throw new TypeError("[object Array] is not an integer shared typed array.");
      return tag.indexOf("Big") === 0;
    }
    function idx(ta, i) {
      var n = i === undefined ? 0 : Number(i);
      n = n !== n ? 0 : Math.trunc(n);
      if (n < 0 || n >= ta.length) throw new RangeError("Invalid atomic access index");
      return n;
    }
    function val(big, v) { return big ? BigInt(v) : (function (n) { n = Number(n); return n !== n ? 0 : Math.trunc(n); })(v); }
    function rmw(op) {
      return function (ta, i, v) {
        var big = check(ta), k = idx(ta, i), x = val(big, v), old = ta[k];
        ta[k] = op(old, x);
        log({ k: "atomics", op: op.name || "rmw" });
        return old;
      };
    }
    var A = {
      add: rmw(function add(a, b) { return a + b; }), sub: rmw(function sub(a, b) { return a - b; }),
      and: rmw(function and(a, b) { return a & b; }), or: rmw(function or(a, b) { return a | b; }), xor: rmw(function xor(a, b) { return a ^ b; }),
      exchange: rmw(function exchange(a, b) { return b; }),
      compareExchange: function compareExchange(ta, i, expected, replacement) {
        var big = check(ta), k = idx(ta, i), e = val(big, expected), r = val(big, replacement), old = ta[k];
        // karşılaştırma dizinin eleman türüne dönüştürülmüş değerle yapılır
        var tmp = new ta.constructor(1); tmp[0] = e;
        if (old === tmp[0]) ta[k] = r;
        return old;
      },
      load: function load(ta, i) { check(ta); return ta[idx(ta, i)]; },
      store: function store(ta, i, v) { var big = check(ta), k = idx(ta, i), x = val(big, v); ta[k] = x; return Object.is(x, -0) ? 0 : x; },
      isLockFree: function isLockFree(n) { n = Number(n); return n === 1 || n === 2 || n === 4 || n === 8; },
      wait: function wait(ta, i, v) {
        check(ta, true); idx(ta, i);
        throw new TypeError("Atomics.wait cannot be called in this context");
      },
      waitAsync: function waitAsync(ta, i, v, timeout) {
        var big = check(ta, true), k = idx(ta, i), x = val(big, v);
        var t = timeout === undefined ? Infinity : Number(timeout);
        if (ta[k] !== x) return { async: false, value: "not-equal" };
        if (t <= 0) return { async: false, value: "timed-out" };
        var w = { ta: ta, k: k };
        var p = new Promise(function (res) { w.res = res; });
        waiters.push(w);
        if (t !== Infinity && typeof setTimeout === "function") setTimeout(function () { var j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); w.res("timed-out"); } }, t);
        return { async: true, value: p };
      },
      notify: function notify(ta, i, count) {
        check(ta, true); var k = idx(ta, i);
        var c = count === undefined ? Infinity : Math.max(0, Math.trunc(Number(count)) || 0), n = 0;
        for (var j = 0; j < waiters.length && n < c;) {
          if (waiters[j].ta.buffer === ta.buffer && waiters[j].k === k) { waiters.splice(j, 1)[0].res("ok"); n++; } else j++;
        }
        return n;
      },
      pause: function pause() {},
    };
    Object.defineProperty(A, Symbol.toStringTag, { value: "Atomics", configurable: true });
    globalThis.Atomics = A;
  }

  // ---------------------------------------------------------------- E540 WeakRef / FinalizationRegistry (hiç toplanmayan çalıştırma: spec'e uygun)
  function canBeHeld(v) { return (v !== null && (typeof v === "object" || typeof v === "function")) || (typeof v === "symbol" && Symbol.keyFor(v) === undefined); }
  if (typeof globalThis.WeakRef === "undefined") {
    var WeakRef = function WeakRef(target) {
      if (!new.target) throw new TypeError("Constructor WeakRef requires 'new'");
      if (!canBeHeld(target)) throw new TypeError("WeakRef: target must be an object");
      Object.defineProperty(this, "__t", { value: target });
      log({ k: "weak", api: "WeakRef" });
    };
    WeakRef.prototype.deref = function deref() { return this.__t; };
    Object.defineProperty(WeakRef.prototype, Symbol.toStringTag, { value: "WeakRef", configurable: true });
    globalThis.WeakRef = WeakRef;
  }
  if (typeof globalThis.FinalizationRegistry === "undefined") {
    var FR = function FinalizationRegistry(cb) {
      if (!new.target) throw new TypeError("Constructor FinalizationRegistry requires 'new'");
      if (typeof cb !== "function") throw new TypeError("FinalizationRegistry: cleanup must be callable");
      Object.defineProperty(this, "__cells", { value: [] });
      log({ k: "weak", api: "FinalizationRegistry" });
    };
    FR.prototype.register = function register(target, held, token) {
      if (!canBeHeld(target)) throw new TypeError("FinalizationRegistry.prototype.register: invalid target");
      if (target === held) throw new TypeError("FinalizationRegistry.prototype.register: target and holdings must not be same");
      if (token !== undefined && !canBeHeld(token)) throw new TypeError("FinalizationRegistry.prototype.register: invalid unregister token");
      this.__cells.push({ token: token });
      return undefined;
    };
    FR.prototype.unregister = function unregister(token) {
      if (!canBeHeld(token)) throw new TypeError("Invalid unregisterToken");
      var before = this.__cells.length;
      for (var i = this.__cells.length - 1; i >= 0; i--) if (this.__cells[i].token === token) this.__cells.splice(i, 1);
      return this.__cells.length !== before;
    };
    Object.defineProperty(FR.prototype, Symbol.toStringTag, { value: "FinalizationRegistry", configurable: true });
    globalThis.FinalizationRegistry = FR;
  }

  // ---------------------------------------------------------------- E516 queueMicrotask
  if (typeof globalThis.queueMicrotask !== "function") {
    // yerel then/resolve: analizdeki then kaydına ayrı bir mikro görev olarak düşmesin
    var qmThen = Promise.prototype.then, qmP = Promise;
    globalThis.queueMicrotask = function queueMicrotask(cb) {
      if (typeof cb !== "function") throw new TypeError("Failed to execute 'queueMicrotask': The callback provided as parameter 1 is not a function.");
      qmThen.call(qmP.resolve(), function () {
        log({ k: "micro", api: "queueMicrotask", fn: fname(cb) });
        try { cb(); } catch (e) { log({ k: "error", where: "queueMicrotask", message: String(e && e.message) }); }
      });
    };
  }

  // modelin eklediği global'ler (Intl, Atomics, WeakRef...) programın eklediği global'ler gibi raporlanmasın
  globalThis.__peelBaseGlobals = Object.getOwnPropertyNames(globalThis);
  if (!semOn) return;

  // ---------------------------------------------------------------- E516 olay döngüsü modeli (yalnızca analiz)
  var tasks = [], taskSeq = 0, virtualNow = 0;
  function schedule(kind, fn, ms, args, repeat) {
    if (typeof fn !== "function") { var src = String(fn); fn = function () { (0, eval)(src); }; }
    var id = ++taskSeq;
    var delay = Math.max(0, Number(ms) || 0);
    tasks.push({ id: id, kind: kind, fn: fn, args: args, at: virtualNow + delay, delay: delay, repeat: repeat, runs: 0 });
    return id;
  }
  globalThis.setTimeout = function setTimeout(fn, ms) { return schedule("setTimeout", fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  globalThis.setInterval = function setInterval(fn, ms) { return schedule("setInterval", fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  globalThis.clearTimeout = globalThis.clearInterval = function clearTimeout(id) { tasks = tasks.filter(function (t) { return t.id !== id; }); };
  globalThis.requestAnimationFrame = function requestAnimationFrame(fn) { return schedule("requestAnimationFrame", fn, 16, [0], false); };
  globalThis.__peelTick = function () {
    if (!tasks.length) return false;
    tasks.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    var t = tasks.shift();
    virtualNow = Math.max(virtualNow, t.at);
    log({ k: "macro", api: t.kind, fn: fname(t.fn), at: virtualNow });
    try { t.fn.apply(globalThis, t.args); } catch (e) { log({ k: "error", where: t.kind, message: String(e && e.message) }); }
    // setInterval en fazla 3 kez: sonsuz döngü modelde kesilir
    if (t.repeat && ++t.runs < 3) { t.at = virtualNow + Math.max(1, t.delay); tasks.push(t); }
    return true;
  };

  // ---------------------------------------------------------------- E516/E517 söz izleme
  var NativePromise = Promise;
  var origThen = NativePromise.prototype.then;
  var tracked = [];
  var states = new WeakMap();
  function track(p, where) {
    if (p && typeof p === "object" && !states.has(p)) { states.set(p, { handled: false, probed: false, settled: null, reason: null, reported: false, where: where }); tracked.push(p); }
    return p;
  }
  function markHandled(p) {
    var s = states.get(p);
    if (s) { if (s.reported && !s.handled) log({ k: "rejectionhandled", where: s.where }); s.handled = true; }
  }
  function isThenable(v) { try { return v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function" && !(v instanceof NativePromise); } catch (e) { return false; } }
  function wrapCb(cb, kind) {
    if (typeof cb !== "function") return cb;
    return function (v) { log({ k: "micro", api: kind, fn: fname(cb) }); return cb.apply(this, arguments); };
  }
  NativePromise.prototype.then = function then(a, b) {
    markHandled(this);
    return track(origThen.call(this, wrapCb(a, "then"), wrapCb(b, "catch")), "then");
  };
  var origResolve = NativePromise.resolve;
  globalThis.Promise = new Proxy(NativePromise, {
    construct: function (tg, args, nt) {
      var exec = args[0];
      var wrapped = typeof exec !== "function" ? exec : function (res, rej) {
        return exec(function (v) { if (isThenable(v)) log({ k: "thenable", via: "resolve" }); return res(v); }, rej);
      };
      return track(Reflect.construct(tg, [wrapped], nt), "new Promise");
    },
    get: function (tg, k, r) {
      if (k === "resolve") return function resolve(v) { if (isThenable(v)) log({ k: "thenable", via: "Promise.resolve" }); return track(origResolve.call(this === globalThis.Promise ? tg : this, v), "Promise.resolve"); };
      var v = Reflect.get(tg, k, r);
      if (typeof v === "function" && (k === "reject" || k === "all" || k === "allSettled" || k === "race" || k === "any")) {
        return function () { return track(v.apply(this === globalThis.Promise ? tg : this, arguments), "Promise." + String(k)); };
      }
      return v;
    },
  });
  globalThis.__peelTrackFn = function (f, where) {
    var w = function () { return track(Reflect.apply(f, this, arguments), where); };
    try { Object.defineProperty(w, "name", { value: f.name }); Object.defineProperty(w, "length", { value: f.length }); } catch (e) {}
    return w;
  };
  globalThis.__peelAwait = function (v, where) {
    if (v instanceof NativePromise) markHandled(v);
    else if (isThenable(v)) log({ k: "thenable", via: "await", where: where });
    return v;
  };
  globalThis.__peelResume = function (v, where) { log({ k: "micro", api: "await", fn: where }); return v; };
  globalThis.__peelSemMark = function (what) { log({ k: what }); };
  globalThis.__peelProbe = function () {
    tracked.forEach(function (p) {
      var s = states.get(p);
      if (s.probed) return;
      s.probed = true;
      origThen.call(p, function () { s.settled = "fulfilled"; }, function (e) { s.settled = "rejected"; s.reason = String(e && e.message !== undefined ? e.message : e); });
    });
  };
  globalThis.__peelCheck = function () {
    tracked.forEach(function (p) {
      var s = states.get(p);
      if (s.settled === "rejected" && !s.handled && !s.reported) { s.reported = true; log({ k: "unhandled", where: s.where, reason: s.reason }); }
    });
    tracked = tracked.filter(function (p) { var s = states.get(p); return s.settled === null || (!s.handled && s.settled === "rejected"); });
  };
})();
`;
