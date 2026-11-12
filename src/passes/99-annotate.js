import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { createInferer } from '../naming/types.js';
import { summarizeFunction, facts } from '../naming/summary.js';

// 73: fonksiyon açıklama yorumları, 76: JSDoc tip açıklamaları, E238: bölüm başlıkları.
// Yalnızca yorum ekler (davranış değişmez). Kendi yorumları @summary / "── " ile tanınır ve her turda
// yeniden üretilir: çıktı tur sayısından bağımsız ve kararlıdır.

const OWN_DOC = /^\*\s*\n\s*\*\s*@summary /;
const OWN_HEADER = /^ ── .+ ──$/;
const isOwn = (c) => (c.type === 'CommentBlock' && OWN_DOC.test(c.value)) || (c.type === 'CommentLine' && OWN_HEADER.test(c.value));
const MIN_SECTION_STATEMENTS = 6;

function jsdoc(summary, sig, kind) {
  const lines = [`@summary ${summary}`];
  if (kind) lines.push(kind);
  for (const p of sig.params) {
    const ty = p.type === 'unknown' ? '*' : p.type;
    lines.push(`@param {${p.optional ? `${ty}=` : ty}} ${p.name.replace(/^\.\.\./, '')}`);
  }
  if (sig.returns !== 'void' && kind !== '@constructor') lines.push(`@returns {${sig.returns === 'unknown' ? '*' : sig.returns}}`);
  // */ yorum içinde kapanışa dönüşmesin
  return `*\n${lines.map((l) => ` * ${l.replace(/\*\//g, '*\\/')}`).join('\n')}\n `;
}

const stripOwn = (node) => {
  if (node.leadingComments) node.leadingComments = node.leadingComments.filter((c) => !isOwn(c));
};

function attach(node, value) {
  stripOwn(node);
  node.leadingComments = [...(node.leadingComments ?? []), { type: 'CommentBlock', value }];
}

// Üst düzey deyimin bölüm kategorisi
function category(st) {
  const s = t.isExportNamedDeclaration(st.node) || t.isExportDefaultDeclaration(st.node) ? st.get('declaration') : st;
  if (!s?.node) return 'Ana akış';
  if (s.isImportDeclaration()) return 'İçe aktarmalar';
  if (s.isClassDeclaration()) return 'Sınıflar';
  if (s.isVariableDeclaration()) {
    const inits = s.node.declarations.map((d) => d.init);
    if (inits.every((i) => !i || t.isLiteral(i) || t.isArrayExpression(i) || t.isObjectExpression(i) || t.isUnaryExpression(i))) return 'Sabitler ve durum';
    if (inits.some((i) => t.isFunction(i))) return fnCategory(s.get('declarations').find((d) => t.isFunction(d.node.init)).get('init'));
    return 'Değişkenler';
  }
  if (s.isFunctionDeclaration()) return fnCategory(s);
  return 'Ana akış';
}

function fnCategory(fn) {
  const f = facts(fn);
  if (f.network.size) return 'Ağ işlemleri';
  if (f.domWrite || f.domRead || f.events.size) return 'Sayfa (DOM) işlemleri';
  if (f.storage) return 'Depolama';
  if (f.decode || f.crypto) return 'Kodlama ve şifreleme';
  return 'Yardımcı fonksiyonlar';
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.annotate === false) return;
  const inf = createInferer();
  // önceki turların yorumları (silinen düğümlerden kardeşlere taşınmış olanlar dahil) temizlenir
  t.traverseFast(ast.program, (n) => {
    for (const k of ['leadingComments', 'trailingComments', 'innerComments']) {
      if (n[k]?.length) n[k] = n[k].filter((c) => !isOwn(c));
    }
  });
  let docs = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const { text, sig } = summarizeFunction(p, inf);
      const ctor = isConstructor(p);
      attach(p.node, jsdoc(ctor ? `Kurucu fonksiyon: ${text}` : text, sig, ctor ? '@constructor' : null));
      docs++;
    },
    VariableDeclaration(p) {
      if (p.node.declarations.length !== 1) return;
      const d = p.get('declarations.0');
      const init = d.get('init');
      if (!t.isIdentifier(d.node.id) || !(init.isFunctionExpression() || init.isArrowFunctionExpression())) return;
      if (!(p.parentPath.isProgram() || p.parentPath.isBlockStatement() || p.parentPath.isExportNamedDeclaration())) return;
      const { text, sig } = summarizeFunction(init, inf);
      attach(p.parentPath.isExportNamedDeclaration() ? p.parent : p.node, jsdoc(text, sig, null));
      docs++;
    },
    ClassMethod(p) {
      if (p.node.computed) return;
      const { text, sig } = summarizeFunction(p, inf);
      attach(p.node, jsdoc(p.node.kind === 'constructor' ? `Kurucu: ${text}` : text, sig, null));
      docs++;
    },
    ClassDeclaration(p) {
      const methods = p.node.body.body.filter((m) => t.isClassMethod(m) && m.kind === 'method' && t.isIdentifier(m.key)).map((m) => m.key.name);
      const text = `Sınıf${methods.length ? `; metotları: ${methods.slice(0, 6).join(', ')}` : ''}`;
      attach(p.node, `*\n * @summary ${text}\n `);
      docs++;
    },
  });

  // E238: bölüm başlıkları (yeterince uzun programlarda, kategori değiştikçe)
  let headers = 0;
  traverse(ast, {
    Program(p) {
      const body = p.get('body');
      for (const st of body) {
        if (st.node.leadingComments) st.node.leadingComments = st.node.leadingComments.filter((c) => !(c.type === 'CommentLine' && OWN_HEADER.test(c.value)));
      }
      if (naming.sections === false || body.length < MIN_SECTION_STATEMENTS) return p.stop();
      const cats = body.map(category);
      const runs = cats.filter((c, i) => i === 0 || c !== cats[i - 1]).length;
      if (runs < 2) return p.stop();
      cats.forEach((c, i) => {
        if (i > 0 && c === cats[i - 1]) return;
        const node = body[i].node;
        node.leadingComments = [{ type: 'CommentLine', value: ` ── ${c} ──` }, ...(node.leadingComments ?? [])];
        headers++;
      });
      p.stop();
    },
  });
  if (docs || headers) onLog(`annotate: ${docs} açıklama, ${headers} bölüm başlığı`, 'info');
  bump('annotate', docs);
}

// this alanları kurup new ile çağrılan fonksiyon
function isConstructor(p) {
  const b = p.parentPath.scope.getBinding(p.node.id.name);
  return Boolean(b?.referencePaths.some((r) => r.parentPath.isNewExpression({ callee: r.node })));
}
