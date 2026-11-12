import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { scan, renameBlocker, runsAfter, isStrict, strictSafe, callOnlyProperty } from '../naming/scope.js';

// 77: function Foo() {…}  Foo.prototype.m = function () {…};  →  class Foo { constructor() {…} m() {…} }
// Davranış farkları ve kanıtları:
//  - sınıf new'siz çağrılamaz      → Foo yalnızca new, instanceof ve statik üye erişimiyle kullanılıyor
//  - class bildirimi hoist edilmez → her kullanım son prototype atamasından sonra çalışıyor
//  - metotlar sayılamaz, new'lenemez → programda for-in/Object.keys yok, metot adları yalnızca çağrılıyor
//  - sınıf gövdesi sıkı moddadır    → kod zaten sıkı ya da gövdeler sıkı moda uygun (scope.strictSafe)
// Foo.prototype = {…} biçimi çevrilmez: constructor özelliği kaybolduğu için örnekler farklı davranır.

const memberKey = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name
  : t.isStringLiteral(m.property) ? m.property.value : null);

// Foo.prototype.m = function () {…};
function protoMethod(st, name) {
  if (!t.isExpressionStatement(st)) return null;
  const e = st.expression;
  if (!t.isAssignmentExpression(e, { operator: '=' }) || !t.isFunctionExpression(e.right)) return null;
  const l = e.left;
  if (!t.isMemberExpression(l) || !t.isMemberExpression(l.object)) return null;
  if (!t.isIdentifier(l.object.object, { name }) || memberKey(l.object) !== 'prototype') return null;
  const key = memberKey(l);
  if (!key || key === 'constructor' || !t.isValidIdentifier(key)) return null;
  return { key, fn: e.right, member: l };
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.classes === false) return;
  const info = scan(ast);
  let n = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const fn = p.node;
      if (!fn.id || fn.async || fn.generator || !p.inList) return;
      const container = p.parentPath;
      // sloppy modda blok içi fonksiyon bildirimi (Annex B) farklı kapsamlanır
      if (!(container.isProgram() || container.parentPath?.isFunction()) && !isStrict(p)) return;
      const name = fn.id.name;
      const methods = [];
      for (let k = p.key + 1; k < container.node.body.length; k++) {
        const m = protoMethod(container.node.body[k], name);
        if (!m) break;
        methods.push({ ...m, index: k });
      }
      if (!methods.length) return;
      const b = p.scope.getBinding(name);
      if (!b || b.kind !== 'hoisted' || !b.constant || renameBlocker(info, b)) return;
      const lastStmt = container.get(`body.${methods.at(-1).index}`);
      const end = lastStmt.node.end;
      const memberNodes = new Set(methods.map((m) => m.member.object));
      for (const r of b.referencePaths) {
        if (memberNodes.has(r.parent)) continue;
        if (!runsAfter(r, end, container, info)) return;
        const par = r.parentPath;
        if (par.isNewExpression({ callee: r.node })) continue;
        if (par.isBinaryExpression({ operator: 'instanceof', right: r.node })) continue;
        if (par.isMemberExpression({ object: r.node })) {
          const k = memberKey(par.node);
          if (!k || ['call', 'apply', 'bind', 'caller', 'arguments'].includes(k)) return;
          // Foo.prototype.x = değer (veri özelliği) sınıfta da aynı çalışır; başka prototype erişimi yok
          if (k === 'prototype') {
            const outer = par.parentPath;
            if (!(outer.isMemberExpression({ object: par.node }) && outer.parentPath.isAssignmentExpression({ left: outer.node }) &&
              !t.isFunction(outer.parent.right))) return;
          }
          continue;
        }
        return;
      }
      // metot adları programda yalnızca çağrılıyor olmalı (tanımlayan atamalar hariç)
      const allowed = new Set(methods.map((m) => m.member));
      for (const m of methods) {
        if (!callOnlyProperty(info, m.key, allowed)) return;
        if (m.fn.id && container.get(`body.${m.index}.expression.right`).scope.getBinding(m.fn.id.name)?.referencePaths.length) return;
      }
      if (!isStrict(p)) {
        if (!strictSafe(p)) return;
        for (const m of methods) if (!strictSafe(container.get(`body.${m.index}.expression.right`))) return;
      }
      const body = [];
      if (fn.params.length || fn.body.body.length || fn.body.directives.length) {
        body.push(t.classMethod('constructor', t.identifier('constructor'), fn.params, fn.body));
      }
      for (const m of methods) {
        const cm = t.classMethod('method', t.identifier(m.key), m.fn.params, m.fn.body, false, false, m.fn.generator, m.fn.async);
        t.inheritsComments(cm, container.node.body[m.index]);
        body.push(cm);
      }
      const cls = t.classDeclaration(t.identifier(name), null, t.classBody(body));
      t.inheritsComments(cls, fn);
      for (let k = methods.length - 1; k >= 0; k--) container.get(`body.${methods[k].index}`).remove();
      // eski fonksiyon binding'i kalkmazsa Babel aynı adlı class'ı "duplicate declaration" sayar
      b.scope.removeOwnBinding(name);
      p.replaceWith(cls);
      n++;
    },
  });
  if (n) onLog(`classes: ${n} prototype yapısı class oldu`, 'info');
  bump('classes', n);
}
