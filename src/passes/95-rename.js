import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// Yalnızca üretilmiş isimler (_0x1a2b, _0xabc) yeniden adlandırılır; anlamlı isimlere dokunulmaz.
// İsimler deterministiktir: aynı girdi her çalıştırmada aynı çıktıyı verir.
const GENERATED = /^_0x[0-9a-f]+$/i;
const PREFIX = { hoisted: 'fn', local: 'fn', param: 'arg', var: 'v', let: 'v', const: 'c' };

export async function run(ast, { onLog, bump }) {
  const taken = new Set();
  let dynamic = false;
  traverse(ast, {
    Identifier(p) { taken.add(p.node.name); },
    WithStatement() { dynamic = true; },
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamic = true; },
  });
  if (dynamic) {
    onLog('rename: eval/with mevcut, atlandı', 'warn');
    return;
  }

  const counters = {};
  const fresh = (prefix) => {
    let name;
    do { counters[prefix] = (counters[prefix] ?? 0) + 1; name = `${prefix}${counters[prefix]}`; } while (taken.has(name));
    taken.add(name);
    return name;
  };

  let n = 0;
  traverse(ast, {
    Scopable: {
      enter(p) {
        for (const [name, binding] of Object.entries(p.scope.bindings)) {
          if (!GENERATED.test(name)) continue;
          const prefix = PREFIX[binding.kind];
          if (!prefix) continue;
          // class bildiriminin kendi kapsamındaki ad kopyası: dış bağ zaten yeniden adlandırıldı, ikinci kez adlandırmak
          // sınıfı dış referanslardan koparır (class v6 {} ... new v1())
          if (p.isClassDeclaration() && binding.identifier === p.node.id) continue;
          p.scope.rename(name, fresh(prefix));
          n++;
        }
      },
    },
  });
  if (n) onLog(`rename: ${n} isim değiştirildi`, 'info');
  bump('rename', n);
}
