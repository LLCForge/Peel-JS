import * as t from '@babel/types';
import { parse } from '../core/parse.js';

const MAX_DEPTH = 4;
const MAX_SRC = 3_000_000;
const MIN_PAYLOAD = 12;

// eval ve Function kurucusunu yakalayan kancalar. jsfuck/aaencode/jjencode Function'a
// [].filter.constructor zinciriyle ulaştığı için Function.prototype.constructor da değiştirilir.
const HOOKS = `
var __captured = [];
var __fake = function () {
  var a = Array.prototype.slice.call(arguments);
  __captured.push(String(a.length ? a[a.length - 1] : ""));
  return function () {};
};
try { Object.defineProperty(Function.prototype, "constructor", { value: __fake, configurable: true, writable: true }); } catch (e) {}
globalThis.Function = __fake;
globalThis.eval = function (s) { __captured.push(String(s)); };
`;

const JSFUCK = /^[\s[\]()!+]+;?\s*$/;
const AAENCODE = /ﾟДﾟ|ﾟΘﾟ|ﾟｰﾟ/;
const JJENCODE = /\$=~\[\];/;

// Program yalnızca bir kod çözücü sarmalayıcı mı? (packer, eval(atob(..)), jsfuck, aaencode, jjencode ...)
function isWrapperProgram(ast, code) {
  if (JJENCODE.test(code) || AAENCODE.test(code)) return true;
  const body = ast.program.body.filter((s) => !t.isEmptyStatement(s));
  if (body.length !== 1 || !t.isExpressionStatement(body[0])) return false;
  if (JSFUCK.test(code)) return true;
  let e = body[0].expression;
  while (t.isCallExpression(e) || t.isNewExpression(e)) {
    if (t.isIdentifier(e.callee, { name: 'eval' }) || t.isIdentifier(e.callee, { name: 'Function' })) return true;
    e = e.callee;
  }
  return /\[\s*["']constructor["']\s*\]|\.constructor\b/.test(code);
}

async function decodeOnce(code, sandbox) {
  if (code.length > MAX_SRC) return null;
  let ast;
  try { ast = parse(code); } catch { return null; }
  if (!isWrapperProgram(ast, code)) return null;

  const r = await sandbox.run(`${HOOKS}\ntry {\n${code}\n} catch (e) {}\n__res.push.apply(__res, __captured);`, { timeoutMs: 4000 });
  if (!r.ok && !r.res?.length) return null;
  for (const candidate of r.res ?? []) {
    if (typeof candidate !== 'string' || candidate.trim().length < MIN_PAYLOAD || candidate === code) continue;
    try {
      parse(candidate);
      return candidate;
    } catch {
      // sonraki aday
    }
  }
  return null;
}

export async function run(code, { onLog, sandbox }) {
  let current = code;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = await decodeOnce(current, sandbox);
    if (!next) break;
    onLog(`predecoder: katman ${depth + 1} çözüldü (${next.length} karakter)`, 'info');
    current = next;
  }
  return current;
}
