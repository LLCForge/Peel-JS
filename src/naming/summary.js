import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { createInferer } from './types.js';

// Fonksiyon özetleri (73) ve tek paragraf program özeti (81): deterministik program analizi, ağ/model yok.

const propKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);
const memberPath = (n) => {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n)) {
    const k = propKey(n);
    const o = memberPath(n.object);
    return o && k ? `${o}.${k}` : null;
  }
  return null;
};

const NET = /^(fetch|XMLHttpRequest|WebSocket|EventSource)$|\.(sendBeacon|ajax|open|send)$|^axios/;
const DOM_READ = /(getElementById|querySelector|querySelectorAll|getElementsBy\w+|getAttribute|getBoundingClientRect)$/;
const DOM_WRITE_PROPS = new Set(['innerHTML', 'outerHTML', 'textContent', 'innerText', 'src', 'href', 'value', 'className', 'title']);
const DOM_WRITE_CALLS = /(appendChild|append|prepend|insertBefore|removeChild|remove|setAttribute|createElement|write|writeln|insertAdjacentHTML)$/;
const STORAGE = /^(localStorage|sessionStorage|indexedDB)\b|document\.cookie/;
const DECODE = /^(atob|btoa|decodeURIComponent|encodeURIComponent|escape|unescape)$|String\.fromCharCode$|\.charCodeAt$/;
const TIMER = /^(setTimeout|setInterval|requestAnimationFrame)$/;
const CRYPTO = /^crypto\.|subtle\./;
const DYNAMIC = /^(eval|Function)$/;

/** Fonksiyon (ya da program) gövdesinden davranış olguları */
export function facts(path, { deep = false } = {}) {
  const f = {
    network: new Set(), urls: new Set(), domRead: 0, domWrite: 0, storage: 0, decode: 0, timers: 0, crypto: 0, dynamic: 0,
    events: new Set(), calls: new Set(), fields: new Set(), loops: 0, throws: 0, recursion: false, console: 0, awaits: 0, yields: 0,
  };
  const self = path.node.id?.name ?? (path.parentPath?.isVariableDeclarator() ? path.parent.id?.name : null);
  path.traverse({
    Function(p) { if (!deep && !p.isArrowFunctionExpression()) p.skip(); },
    'ForStatement|WhileStatement|DoWhileStatement|ForInStatement|ForOfStatement'() { f.loops++; },
    ThrowStatement() { f.throws++; },
    AwaitExpression() { f.awaits++; },
    YieldExpression() { f.yields++; },
    StringLiteral(p) { if (/^(https?:|wss?:)?\/\/[\w.-]+|^\/[\w-]+\/[\w./-]*$/.test(p.node.value) && f.urls.size < 3) f.urls.add(p.node.value.slice(0, 80)); },
    NewExpression(p) {
      const n = memberPath(p.node.callee);
      if (n && NET.test(n)) f.network.add(n);
      if (n === 'Function') f.dynamic++;
    },
    AssignmentExpression(p) {
      const l = p.node.left;
      if (t.isMemberExpression(l)) {
        const k = propKey(l);
        if (t.isThisExpression(l.object) && k && f.fields.size < 6) f.fields.add(k);
        if (k && DOM_WRITE_PROPS.has(k)) f.domWrite++;
        if (memberPath(l) === 'document.cookie') f.storage++;
        if (k && /^on[a-z]+$/.test(k)) f.events.add(k.slice(2));
      }
    },
    MemberExpression(p) {
      const n = memberPath(p.node);
      if (n && STORAGE.test(n)) f.storage++;
    },
    CallExpression(p) {
      const n = memberPath(p.node.callee);
      if (!n) return;
      if (NET.test(n)) f.network.add(n.split('.').pop());
      if (DOM_READ.test(n)) f.domRead++;
      if (DOM_WRITE_CALLS.test(n) && !/^(localStorage|sessionStorage)/.test(n)) f.domWrite++;
      if (DECODE.test(n)) f.decode++;
      if (TIMER.test(n)) f.timers++;
      if (CRYPTO.test(n)) f.crypto++;
      if (DYNAMIC.test(n)) f.dynamic++;
      if (n.startsWith('console.')) f.console++;
      if (/addEventListener$/.test(n) && t.isStringLiteral(p.node.arguments[0])) f.events.add(p.node.arguments[0].value);
      if (t.isIdentifier(p.node.callee)) {
        if (p.node.callee.name === self) f.recursion = true;
        else if (p.scope.getBinding(p.node.callee.name) && f.calls.size < 6) f.calls.add(p.node.callee.name);
      }
    },
  });
  return f;
}

const list = (set, max = 3) => {
  const a = [...set];
  return a.length > max ? `${a.slice(0, max).join(', ')}…` : a.join(', ');
};

/** Bir fonksiyon için Türkçe tek cümlelik özet + imza */
export function summarizeFunction(path, inf = createInferer()) {
  const f = facts(path);
  const parts = [];
  if (f.fields.size) parts.push(`örnek alanlarını kurar (${list(f.fields, 4)})`);
  if (f.network.size) parts.push(`ağ isteği yapar${f.urls.size ? ` (${list(f.urls, 2)})` : ''}`);
  if (f.domWrite) parts.push('sayfa içeriğini değiştirir');
  else if (f.domRead) parts.push('sayfadan eleman okur');
  if (f.storage) parts.push('tarayıcı depolamasına erişir');
  if (f.events.size) parts.push(`olay dinler (${list(f.events)})`);
  if (f.timers) parts.push('zamanlayıcı kurar');
  if (f.decode) parts.push('string kodlar/çözer');
  if (f.crypto) parts.push('kriptografi kullanır');
  if (f.dynamic) parts.push('çalışma anında kod üretir');
  if (f.awaits) parts.push('asenkron bekler');
  if (f.yields) parts.push('değer üretir (generator)');
  if (f.loops) parts.push(f.loops > 1 ? `${f.loops} döngü içerir` : 'döngü içerir');
  if (f.recursion) parts.push('kendini çağırır');
  if (f.throws) parts.push('hata fırlatabilir');
  if (f.console && parts.length === 0) parts.push('konsola yazar');
  if (f.calls.size) parts.push(`çağırdıkları: ${list(f.calls, 4)}`);
  const sig = inf.fn(path);
  // generic: gövdeden çıkarılabilen bir bilgi yok, özet yalnızca kalıp cümle
  const generic = !parts.length;
  if (generic) {
    parts.push(sig.returns === 'void' ? 'yan etkisiz ya da basit bir işlem yapar' : 'bir değer hesaplar');
  }
  const text = parts.join('; ');
  return { text: text[0].toUpperCase() + text.slice(1), sig, facts: f, generic };
}

/** 81: programın tek paragraflık özeti */
export function programSummary(ast, extra = {}) {
  let fns = 0;
  let classes = 0;
  let program = null;
  const fnNames = [];
  traverse(ast, {
    Program(p) { program = p; },
    Function(p) { fns++; if (p.isFunctionDeclaration() && fnNames.length < 6) fnNames.push(p.node.id.name); },
    Class() { classes++; },
  });
  const f = facts(program, { deep: true });
  const s = [];
  const size = `${fns} fonksiyon${classes ? `, ${classes} sınıf` : ''}`;
  s.push(`Program ${size} içeriyor${fnNames.length ? ` (başlıcaları: ${fnNames.slice(0, 4).join(', ')})` : ''}.`);
  const acts = [];
  if (f.network.size) acts.push(`ağ isteği yapıyor (${list(f.network)})${f.urls.size ? `; adresler: ${list(f.urls, 3)}` : ''}`);
  if (f.domWrite) acts.push('sayfanın DOM içeriğini değiştiriyor');
  else if (f.domRead) acts.push('sayfadaki elemanları okuyor');
  if (f.storage) acts.push('çerez ya da yerel depolamaya erişiyor');
  if (f.events.size) acts.push(`${list(f.events, 4)} olaylarını dinliyor`);
  if (f.timers) acts.push('zamanlayıcılarla tekrar eden iş kuruyor');
  if (f.decode) acts.push('string kodlama/çözme yapıyor');
  if (f.crypto) acts.push('kriptografik işlem yapıyor');
  if (f.dynamic) acts.push('çalışma anında kod üretip çalıştırıyor');
  if (acts.length) s.push(`Kod ${acts.join(', ')}.`);
  else s.push('Kod dış dünyayla (ağ, DOM, depolama) etkileşime girmiyor; hesaplama ve konsol çıktısıyla sınırlı görünüyor.');
  if (extra.threat?.classes?.length) s.push(`Tehdit analizi: ${extra.threat.classes.map((c) => c.id).join(', ')} (risk ${extra.threat.risk?.level ?? '?'}).`);
  if (extra.libraries?.length) s.push(`Tanınan kütüphaneler: ${extra.libraries.map((l) => l.name + (l.version ? ` ${l.version}` : '')).join(', ')}.`);
  if (extra.unresolved?.length) s.push(`${extra.unresolved.length} çözülemeyen öğe kaldı.`);
  return s.join(' ');
}
