import * as prettier from 'prettier/standalone';
import * as babelPlugin from 'prettier/plugins/babel';
import * as estreePlugin from 'prettier/plugins/estree';
import { generate } from '../util/ast.js';

export const raw = (ast) => generate(ast, { comments: true, jsescOption: { minimal: true } }).code;

// E239: biçim profilleri (yalnızca yerleşim; anlam değişmez)
export const FORMAT_PROFILES = {
  default: { printWidth: 100, tabWidth: 2, semi: true, singleQuote: false },
  compact: { printWidth: 80, tabWidth: 2, semi: true, singleQuote: false, bracketSpacing: false, arrowParens: 'avoid' },
  wide: { printWidth: 140, tabWidth: 4, semi: true, singleQuote: false },
  standard: { printWidth: 80, tabWidth: 2, semi: false, singleQuote: true, trailingComma: 'none', arrowParens: 'avoid' },
  airbnb: { printWidth: 100, tabWidth: 2, semi: true, singleQuote: true, trailingComma: 'all' },
  tabs: { printWidth: 100, tabWidth: 4, useTabs: true, semi: true, singleQuote: false },
};

export async function pretty(code, profile = 'default') {
  try {
    return await prettier.format(code, {
      parser: 'babel',
      plugins: [babelPlugin, estreePlugin],
      ...(FORMAT_PROFILES[profile] ?? FORMAT_PROFILES.default),
    });
  } catch {
    return code;
  }
}
