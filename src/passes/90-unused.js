import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { isLiteralTree } from '../util/pure.js';

function hasDynamicScope(ast) {
  let found = false;
  traverse(ast, {
    WithStatement(p) { found = true; p.stop(); },
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) { found = true; p.stop(); }
    },
  });
  return found;
}

// Kaldırılınca gözlenebilir hiçbir şey değişmeyen başlangıç değeri
function isInertInit(path) {
  const n = path.node;
  if (isLiteralTree(n) || t.isFunction(n) || t.isClassExpression(n) && !n.superClass) return true;
  if (t.isIdentifier(n)) return Boolean(path.scope.getBinding(n.name)) || n.name === 'undefined';
  return isFactoryIife(n);
}

// (function () { var x = true; return function () { … }; })() — yalnızca fonksiyon üreten IIFE
// (obfuscator.io'nun "callController"ı). Çağrılması gözlenebilir bir şey yapmaz.
function isFactoryIife(n) {
  if (!t.isCallExpression(n) || n.arguments.length || !t.isFunctionExpression(n.callee)) return false;
  const body = n.callee.body.body;
  const last = body[body.length - 1];
  if (!t.isReturnStatement(last) || !t.isFunction(last.argument)) return false;
  return body.slice(0, -1).every((s) => t.isVariableDeclaration(s) &&
    s.declarations.every((d) => !d.init || isLiteralTree(d.init) || t.isFunction(d.init)));
}

const isExported = (p) => p.findParent((x) => x.isExportDeclaration());

// Örtük çağrılan adlar: olay işleyicileri (on*), dönüşüm/protokol kancaları. Okunmasa da dışarıdan çağrılabilir.
const IMPLICIT = new Set(['toString', 'valueOf', 'toJSON', 'toLocaleString', 'then', 'catch', 'finally', 'handleEvent',
  'constructor', 'next', 'return', 'throw', 'get', 'set', 'apply', 'call', 'bind', 'default', 'exports']);

const isDynamicName = (k) => t.isCallExpression(k) || t.isTemplateLiteral(k) || t.isConditionalExpression(k) ||
  t.isLogicalExpression(k) || (t.isBinaryExpression(k, { operator: '+' }) && !(t.isNumericLiteral(k.left) || t.isNumericLiteral(k.right)));

function rootOf(n) {
  while (t.isMemberExpression(n)) n = n.object;
  return n;
}

// js-confuser kapsam nesneleri: scope.X.f = function () {…}; f hiçbir yerde okunmuyorsa (kopyaları açılmış
// makinelerin ölü sarmalayıcıları) atama kaldırılır. Kök yerel bir değişken olmalı; ad hiçbir yerde
// özellik okuması, nesne anahtarı ya da string olarak geçmemeli.
function deadPropertyStores(ast) {
  const stores = [];
  const used = new Set();
  let dynamicNames = false;
  traverse(ast, {
    ForInStatement(p) { dynamicNames = true; p.stop(); },
    MemberExpression(p) {
      const { node } = p;
      if (node.computed) {
        if (t.isStringLiteral(node.property)) used.add(node.property.value);
        // scope.X[decode(5)], o["a" + b]: ad çalışma anında üretiliyor, hangi özelliğin okunduğu bilinemez
        else if (isDynamicName(node.property)) { dynamicNames = true; p.stop(); }
        return;
      }
      const par = p.parentPath;
      if (par.isAssignmentExpression({ left: node, operator: '=' }) && par.parentPath.isExpressionStatement() && t.isFunction(par.node.right)) {
        stores.push(par);
        return;
      }
      used.add(node.property.name);
    },
    'ObjectProperty|ObjectMethod|ClassProperty|ClassMethod'(p) {
      if (t.isIdentifier(p.node.key)) used.add(p.node.key.name);
    },
    StringLiteral(p) { used.add(p.node.value); },
    TemplateElement(p) { used.add(p.node.value.cooked); },
  });
  if (dynamicNames) return 0;
  let n = 0;
  for (const s of stores) {
    const name = s.node.left.property.name;
    if (used.has(name) || IMPLICIT.has(name) || /^on/.test(name)) continue;
    const root = rootOf(s.node.left);
    if (!t.isIdentifier(root) || !s.scope.getBinding(root.name)) continue;
    s.parentPath.remove();
    n++;
  }
  return n;
}

// Program kapsamındaki bildirimler global'dir: başka script'ler kullanıyor olabilir, bu yüzden sadece maksimum profilde
export async function run(ast, { onLog, bump, level }) {
  if (hasDynamicScope(ast)) {
    onLog('unused: eval/with mevcut, atlandı', 'warn');
    return;
  }
  const allowGlobal = level >= 4;
  // ölü özellik atamaları yalnızca maksimum seviyede; kalan fonksiyon bildirimleri sonraki turda temizlenir
  let n = allowGlobal ? deadPropertyStores(ast) : 0;

  traverse(ast, {
    FunctionDeclaration(p) {
      const scope = p.parentPath.scope;
      if (!p.node.id || isExported(p) || (scope.path.isProgram() && !allowGlobal)) return;
      const b = scope.getBinding(p.node.id.name);
      if (!b || b.constantViolations.length) return;
      if (b.referencePaths.some((r) => !r.findParent((x) => x === p))) return;
      p.remove();
      n++;
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || isExported(p)) return;
      const decl = p.parentPath;
      // for (var n = e, r = 0; …): başka bildirim kalıyorsa kullanılmayan alias çıkarılabilir
      if ((decl.parentPath.isForStatement() && decl.node.declarations.length === 1) || decl.parentPath.isForXStatement()) return;
      const b = p.scope.getBinding(p.node.id.name);
      if (!b || b.referenced || b.constantViolations.length) return;
      if (b.scope.path.isProgram() && !allowGlobal) return;
      if (b.path !== p) return;

      if (!p.node.init || isInertInit(p.get('init'))) {
        p.remove();
        n++;
      } else if (decl.node.declarations.length === 1 && Array.isArray(decl.container)) {
        decl.replaceWith(t.expressionStatement(p.node.init));
        n++;
      }
    },
  });
  if (n) onLog(`unused: ${n} kullanılmayan bildirim kaldırıldı`, 'info');
  bump('unused', n);
}
