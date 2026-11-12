import { parse } from '../core/parse.js';
import { libraries } from '../core/threat.js';
import { programSummary } from './summary.js';
import { compareReadability } from './metrics.js';
import { unresolved } from './unresolved.js';
import { libraryVersions } from './libversion.js';
import { splitModules } from './modules.js';
import { listSuggestions } from './names.js';

// Anlamlandırma raporu: analiz sonrası hafif özetler. Ağır görünümler (CFG, tanım-kullanım, sekans, açıklama)
// arayüzde sekme açılınca güncel çıktı üzerinden hesaplanır.

const MODULE_SOURCE_MAX = 5_000_000;

export function namingReport({ input, text, output, threat = null }) {
  let ast = null;
  try { ast = parse(output); } catch { /* çıktı parse edilemiyorsa yalnızca metin ölçümleri */ }
  const libs = libraries(output);
  const versions = ast ? libraryVersions(ast, libs.map((l) => l.name)) : [];
  const unres = ast ? unresolved(ast) : { items: [], counts: {} };
  const source = text ?? input;
  const modules = source.length <= MODULE_SOURCE_MAX ? splitModules(source) : { format: null, modules: [] };
  return {
    summary: ast ? programSummary(ast, { threat, libraries: libs.map((l) => ({ ...l, version: l.version ?? versions.find((v) => v.name === l.name)?.version ?? null })), unresolved: unres.items }) : '',
    readability: compareReadability(source, output),
    unresolved: unres,
    libraryVersions: versions,
    modules,
    suggestions: listSuggestions(output),
  };
}
