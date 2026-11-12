import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// E38 / E93: obfuscator.io string dizisinin sandbox'sız, sembolik çözümü.
//  - dizi: function A() { var x = [...]; A = function () { return x; }; return A(); }  ya da  var _0x = [...]
//  - decoder: function D(i, k) { i = i - OFS; ... }  →  ofset ifadesi statik değerlendirilir;
//    kodlama gövdeden çıkarılır: yok / base64 (gövdedeki özel alfabeyle) / rc4 (anahtar ikinci argüman)
//  - rotasyon IIFE'si: while(!![]) { try { var v = parseInt(D(..))/1 + ...; if (v === hedef) break; else push(shift()) } }
//    checksum ifadesi, IIFE içindeki yerel sarmalayıcı ve takma adlarla birlikte küçük bir yorumlayıcıda
//    her rotasyonda yeniden hesaplanır; eski sürümlerin while(--n) sayaçlı rotasyonu da desteklenir.
//  - tüm literal argümanlı D çağrıları ve D'yi (anahtarı ayrı fonksiyon parametresinden gelen RC4 dahil)
//    çağıran sarmalayıcı fonksiyon çağrıları çözülür; altyapı referanssız kalırsa silinir.

const MAX_ROTATIONS = 5000;

class Unknown extends Error {}

// obfuscator.io base64: alfabe indeksleri, 4'lü gruplar, ardından % kodlu bayt dizisi decodeURIComponent
function ioBase64(input, alphabet) {
  let n = '';
  for (let p = 0, q = 0, s = 0, r; (r = input.charAt(s++));) {
    r = alphabet.indexOf(r);
    if (~r) {
      q = p % 4 ? q * 64 + r : r;
      if (p++ % 4) n += String.fromCharCode(255 & (q >> ((-2 * p) & 6)));
    }
  }
  let o = '';
  for (let i = 0; i < n.length; i++) o += `%${(`00${n.charCodeAt(i).toString(16)}`).slice(-2)}`;
  return decodeURIComponent(o);
}

function ioRc4(input, key, alphabet) {
  if (typeof key !== 'string') throw new TypeError('rc4 anahtarı string değil');
  const k = ioBase64(input, alphabet);
  const m = [];
  for (let q = 0; q < 256; q++) m[q] = q;
  for (let q = 0, n = 0; q < 256; q++) {
    n = (n + m[q] + key.charCodeAt(q % key.length)) % 256;
    [m[q], m[n]] = [m[n], m[q]];
  }
  let out = '';
  for (let r = 0, q = 0, n = 0; r < k.length; r++) {
    q = (q + 1) % 256;
    n = (n + m[q]) % 256;
    [m[q], m[n]] = [m[n], m[q]];
    out += String.fromCharCode(k.charCodeAt(r) ^ m[(m[q] + m[n]) % 256]);
  }
  return out;
}

const BINOPS = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
  '|': (a, b) => a | b, '&': (a, b) => a & b, '^': (a, b) => a ^ b, '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b, '==': (a, b) => a == b, '!=': (a, b) => a != b, // eslint-disable-line eqeqeq
};

// Küçük yorumlayıcı: literal, aritmetik, parseInt, decoder ve sarmalayıcı çağrıları
function makeEvaluator(fns, state) {
  const resolve = (scope, name, seen = new Set()) => {
    const b = scope.getBinding(name);
    if (!b || seen.has(b)) return null;
    if (fns.has(b)) return fns.get(b);
    seen.add(b);
    const init = t.isVariableDeclarator(b.path.node) ? b.path.node.init : null;
    // takma ad: var h = D;  (tek atama)
    if (init && t.isIdentifier(init) && b.constantViolations.length === 0) return resolve(b.path.scope, init.name, seen);
    return null;
  };
  const evaluate = (node, scope, env) => {
    switch (node.type) {
      case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return node.value;
      case 'UnaryExpression': {
        const v = evaluate(node.argument, scope, env);
        switch (node.operator) { case '-': return -v; case '+': return +v; case '!': return !v; case '~': return ~v; default: throw new Unknown(); }
      }
      case 'BinaryExpression': {
        const op = BINOPS[node.operator];
        if (!op) throw new Unknown();
        return op(evaluate(node.left, scope, env), evaluate(node.right, scope, env));
      }
      case 'Identifier':
        if (env && env.has(node.name)) return env.get(node.name);
        throw new Unknown();
      case 'CallExpression': {
        if (!t.isIdentifier(node.callee)) throw new Unknown();
        const name = node.callee.name;
        const args = node.arguments.map((a) => (t.isSpreadElement(a) ? (() => { throw new Unknown(); })() : evaluate(a, scope, env)));
        if (name === 'parseInt' && !scope.hasBinding('parseInt', true)) return parseInt(args[0], args[1]);
        const fn = resolve(scope, name);
        if (!fn) throw new Unknown();
        return call(fn, args);
      }
      default: throw new Unknown();
    }
  };
  const call = (fn, args) => {
    if (fn.kind === 'decoder') {
      const s = state.array[args[0] - fn.offset];
      if (typeof s !== 'string') throw new TypeError('dizi dışı indeks');
      if (fn.encoding === 'none') return s;
      if (fn.encoding === 'base64') return ioBase64(s, fn.alphabet);
      return ioRc4(s, args[1], fn.alphabet);
    }
    const env = new Map(fn.params.map((p, i) => [p, args[i]]));
    return evaluate(fn.body, fn.scope, env);
  };
  return { evaluate, resolve };
}

// İfadeyi sabit (ortamsız) değerlendirir: ofset için
function constNum(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+')) { const v = constNum(node.argument); return v == null ? null : node.operator === '-' ? -v : v; }
  if (t.isBinaryExpression(node) && BINOPS[node.operator]) { const a = constNum(node.left); const b = constNum(node.right); return a == null || b == null ? null : BINOPS[node.operator](a, b); }
  return null;
}

const stringArray = (n) => (t.isArrayExpression(n) && n.elements.length >= 1 && n.elements.every((e) => t.isStringLiteral(e)) ? n.elements.map((e) => e.value) : null);

export async function run(ast, { onLog, bump }) {
  // 1) string dizisi kaynakları: getter fonksiyonu ya da üst seviye var
  const arrays = new Map(); // binding → string[]
  const infraNodes = new Set(); // dizi, decoder ve sarmalayıcı bildirim düğümleri
  // 2) decoder ve sarmalayıcılar
  const fns = new Map(); // binding → info
  const decoderNodes = [];
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      // dizi getter'ı
      if (!p.node.params.length && body.length >= 2 && t.isVariableDeclaration(body[0]) && body[0].declarations.length === 1) {
        const arr = stringArray(body[0].declarations[0].init);
        if (arr && body.some((s) => t.isReturnStatement(s))) {
          const b = p.parentPath.scope.getBinding(p.node.id.name);
          if (b) { arrays.set(b, arr); infraNodes.add(p.node); }
        }
      }
    },
    VariableDeclarator(p) {
      const arr = stringArray(p.node.init);
      if (arr && arr.length >= 3 && t.isIdentifier(p.node.id) && p.scope.path.isProgram()) {
        const b = p.scope.getBinding(p.node.id.name);
        if (b) { arrays.set(b, arr); infraNodes.add(p.parentPath.node.declarations.length === 1 ? p.node : null); }
      }
    },
  });
  if (!arrays.size) return;
  traverse(ast, {
    FunctionDeclaration(p) {
      const { params, body } = p.node;
      if (!params.length || !params.every((x) => t.isIdentifier(x))) return;
      const first = body.body[0];
      // decoder: i = i - OFS
      if (t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression) && t.isIdentifier(first.expression.left, { name: params[0].name })) {
        const rhs = first.expression.right;
        let offset = null;
        if (first.expression.operator === '=' && t.isBinaryExpression(rhs, { operator: '-' }) && t.isIdentifier(rhs.left, { name: params[0].name })) offset = constNum(rhs.right);
        if (first.expression.operator === '-=') offset = constNum(rhs);
        if (offset == null) return;
        // hangi diziyi okuyor: gövdede dizi getter çağrısı ya da dizi değişkeni
        let array = null;
        p.traverse({
          Identifier(q) {
            const b = q.scope.getBinding(q.node.name);
            if (b && arrays.has(b)) array = b;
          },
        });
        if (!array) return;
        const strings = [];
        p.traverse({ StringLiteral(q) { strings.push(q.node.value); } });
        const alphabet = strings.find((s) => s.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(s) && new Set(s).size === s.length) ?? null;
        const src = JSON.stringify(body, (k, v) => (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' ? undefined : v));
        const rc4 = /"value":256\b/.test(src) && /charCodeAt/.test(src) && alphabet && params.length >= 2;
        const encoding = rc4 ? 'rc4' : alphabet ? 'base64' : 'none';
        const b = p.parentPath.scope.getBinding(p.node.id.name);
        if (!b) return;
        fns.set(b, { kind: 'decoder', offset, encoding, alphabet, array, scope: p.scope });
        infraNodes.add(p.node);
        decoderNodes.push(p);
        return;
      }
      // sarmalayıcı: tek deyim return F(arg ifadeleri)
      if (body.body.length === 1 && t.isReturnStatement(first) && t.isCallExpression(first.argument) && t.isIdentifier(first.argument.callee)) {
        const b = p.parentPath.scope.getBinding(p.node.id.name);
        if (b) { fns.set(b, { kind: 'wrapper', params: params.map((x) => x.name), body: first.argument, scope: p.scope, path: p }); infraNodes.add(p.node); }
      }
    },
  });
  // yalnızca bir decoder'a ulaşan sarmalayıcılar kalır
  const reaches = (info, seen = new Set()) => {
    if (info.kind === 'decoder') return true;
    if (seen.has(info)) return false;
    seen.add(info);
    const b = info.scope.getBinding(info.body.callee.name);
    let target = b && fns.get(b);
    if (!target && b && t.isVariableDeclarator(b.path.node) && t.isIdentifier(b.path.node.init)) target = fns.get(b.path.scope.getBinding(b.path.node.init.name));
    return Boolean(target && reaches(target, seen));
  };
  for (const [b, info] of fns) if (info.kind === 'wrapper' && !reaches(info)) fns.delete(b);
  const decoders = [...fns.values()].filter((f) => f.kind === 'decoder');
  if (!decoders.length) return;

  // 3) her dizi için rotasyonu çöz (dizi başına bağımsız durum)
  const states = new Map();
  for (const [arrB, arr] of arrays) states.set(arrB, { array: [...arr] });
  const rotationStmts = [];
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isFunctionExpression(callee) || args.length < 2 || !t.isIdentifier(args[0])) return;
      const arrB = p.scope.getBinding(args[0].name);
      if (!arrB || !states.has(arrB)) return;
      const target = constNum(args[1]);
      if (target == null) return;
      const state = states.get(arrB);
      const stmt = p.parentPath.isExpressionStatement() ? p.parentPath : p.parentPath.parentPath?.isExpressionStatement() ? p.parentPath.parentPath : null;
      const fnPath = p.get('callee');
      // eski biçim: while (--k) push(shift())  → hedef kez döndür
      const oldStyle = /while\s*\(\s*--/.test(String(fnPath.toString?.() ?? ''));
      if (oldStyle) {
        for (let i = 0; i < target % Math.max(1, state.array.length); i++) state.array.push(state.array.shift());
        if (stmt) rotationStmts.push(stmt);
        return;
      }
      let expr = null;
      let exprPath = null;
      fnPath.traverse({
        TryStatement(q) {
          const decl = q.node.block.body[0];
          if (!expr && t.isVariableDeclaration(decl) && decl.declarations[0]?.init) { expr = decl.declarations[0].init; exprPath = q.get('block.body.0.declarations.0.init'); }
        },
      });
      if (!expr) return;
      const ev = makeEvaluator(fns, state);
      for (let i = 0; i <= Math.min(MAX_ROTATIONS, state.array.length * 2); i++) {
        let v;
        try { v = ev.evaluate(expr, exprPath.scope, null); } catch (e) {
          if (e instanceof Unknown) return; // ifade tanınmıyor: dokunma
          v = NaN; // çalışma anında da try/catch → rotasyon
        }
        if (v === target) {
          state.solved = true;
          if (stmt) rotationStmts.push(stmt);
          return;
        }
        state.array.push(state.array.shift());
      }
      state.failed = true;
    },
  });
  for (const s of states.values()) if (s.failed) { onLog('static-string-array: rotasyon çözülemedi', 'warn'); return; }

  // 4) literal argümanlı decoder / sarmalayıcı çağrılarını çöz
  let n = 0;
  const rotationNodes = new Set(rotationStmts.map((s) => s.node));
  traverse(ast, {
    CallExpression: {
      exit(p) {
        // argümanlar literal ya da sabit aritmetik (sarmalayıcılar açıldıktan sonra 1458 - 981 gibi)
        if (!t.isIdentifier(p.node.callee) || !p.node.arguments.every((a) => t.isStringLiteral(a) || constNum(a) != null)) return;
        if (p.findParent((x) => rotationNodes.has(x.node))) return;
        const probe = makeEvaluator(fns, { array: [] });
        const fn = probe.resolve(p.scope, p.node.callee.name);
        if (!fn) return;
        // çağrının dayandığı decoder'ın dizi durumu
        let d = fn;
        for (let guard = 0; d.kind === 'wrapper' && guard < 20; guard++) d = probe.resolve(d.scope, d.body.callee.name) ?? d;
        if (d.kind !== 'decoder') return;
        const state = states.get(d.array);
        let value;
        try { value = makeEvaluator(fns, state).evaluate(p.node, p.scope, null); } catch { return; }
        if (typeof value !== 'string') return;
        p.replaceWith(t.stringLiteral(value));
        n++;
      },
    },
  });
  if (!n) return;

  // 5) altyapı: decoder/sarmalayıcı/dizi ve rotasyon referanssız kaldıysa sil
  traverse(ast, { Program(p) { p.scope.crawl(); } });
  const infra = new Set([...rotationStmts.map((s) => s.node)]);
  let removed = 0;
  traverse(ast, {
    Program(prog) {
      const live = (b, own) => b.referencePaths.some((r) => !r.findParent((x) => x.node === own || infra.has(x.node)));
      for (let pass = 0; pass < 3; pass++) {
        prog.traverse({
          FunctionDeclaration(p) {
            const b = p.parentPath.scope.getBinding(p.node.id?.name);
            if (!b || infra.has(p.node)) return;
            // crawl sonrası bağlama nesneleri yenilenir: aday kümesi düğüm kimliğiyle tutulur
            if (!infraNodes.has(p.node)) return;
            if (!live(b, p.node)) { infra.add(p.node); }
          },
          VariableDeclarator(p) {
            // var x = D; takma adları
            if (!t.isIdentifier(p.node.id) || !t.isIdentifier(p.node.init)) return;
            const target = p.scope.getBinding(p.node.init.name);
            if (!target || !infraNodes.has(target.path.node)) return;
            const b = p.scope.getBinding(p.node.id.name);
            if (b && !live(b, p.node)) infra.add(p.node);
          },
        });
      }
      prog.traverse({
        'FunctionDeclaration|VariableDeclarator|ExpressionStatement'(p) {
          if (!infra.has(p.node)) return;
          if (p.isVariableDeclarator() && p.parentPath.node.declarations.length === 1) p.parentPath.remove();
          else p.remove();
          removed++;
        },
      });
    },
  });
  onLog(`static-string-array: ${n} string sembolik çözüldü${removed ? `, ${removed} altyapı deyimi silindi` : ''}`, 'info');
  bump('staticStringArray', n);
}
