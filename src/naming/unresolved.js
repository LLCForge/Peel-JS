import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// 94: çözülemeyenler. Çıktıda kalan gizleme izleri satır ve nedeniyle listelenir.

const MAX_ITEMS = 300;
const short = (n) => {
  const s = gen(n).replace(/\s+/g, ' ');
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

export function unresolved(ast) {
  const items = [];
  const add = (node, kind, reason) => {
    if (items.length < MAX_ITEMS) items.push({ line: node.loc?.start.line ?? null, kind, reason, code: short(node) });
  };
  const seenIds = new Set();
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      const args = n.arguments;
      // decoder biçimli çağrı: hex/sayı argümanlı yerel fonksiyon, sonucu sabite inmemiş
      if (t.isIdentifier(n.callee) && args.length && args.every((a) => t.isNumericLiteral(a) || t.isStringLiteral(a)) &&
        args.some((a) => /^0x/i.test(a.extra?.raw ?? ''))) {
        add(n, 'decoder', 'hex argümanlı çağrı çözülemedi');
      }
      const callee = n.callee;
      const dyn = (t.isIdentifier(callee, { name: 'eval' }) || t.isIdentifier(callee, { name: 'Function' })) && !p.scope.getBinding(callee.name);
      if (dyn && args.length && !args.every((a) => t.isStringLiteral(a))) add(n, 'dynamic-code', 'çalışma anında üretilen kod (statik çözülemez)');
      if (t.isIdentifier(callee) && /^(setTimeout|setInterval)$/.test(callee.name) && args[0] && !t.isFunction(args[0]) && !t.isIdentifier(args[0])) {
        add(n, 'dynamic-code', 'string ile zamanlayıcı');
      }
    },
    NewExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'Function' }) && !p.scope.getBinding('Function')) add(p.node, 'dynamic-code', 'new Function ile kod üretimi');
    },
    Identifier(p) {
      const name = p.node.name;
      if (!/^_0x[0-9a-f]+$/i.test(name) || seenIds.has(name)) return;
      seenIds.add(name);
      add(p.node, 'identifier', 'üretilmiş isim kaldı (yeniden adlandırma engellendi ya da dinamik kapsam)');
    },
    MemberExpression(p) {
      // string tablosu kalıntısı: tabloya hex indeksle erişim
      if (p.node.computed && t.isNumericLiteral(p.node.property) && /^0x/i.test(p.node.property.extra?.raw ?? '') && t.isIdentifier(p.node.object)) {
        add(p.node, 'table', 'string tablosuna indeksle erişim kaldı');
      }
    },
    StringLiteral(p) {
      const v = p.node.value;
      if (v.length >= 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) add(p.node, 'encoded', 'base64 görünümlü uzun string');
      else if (/\\x[0-9a-f]{2}/i.test(p.node.extra?.raw ?? '') && v.length > 3) add(p.node, 'escaped', 'kaçışlı string literal');
    },
    DebuggerStatement(p) { add(p.node, 'anti-debug', 'debugger deyimi kaldı'); },
    WithStatement(p) { add(p.node.object, 'with', 'with bloğu: isimler dinamik çözülür'); },
  });
  // VM işaretleri yorumlarda
  for (const c of ast.comments ?? []) {
    if (/PEEL VM/.test(c.value)) items.push({ line: c.loc?.start.line ?? null, kind: 'vm', reason: 'yorumlanan durum makinesi (VM) açılamadı', code: c.value.trim().slice(0, 80) });
  }
  const counts = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { items: items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)), counts };
}
