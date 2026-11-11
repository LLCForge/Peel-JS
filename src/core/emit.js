import * as prettier from 'prettier/standalone';
import * as babelPlugin from 'prettier/plugins/babel';
import * as estreePlugin from 'prettier/plugins/estree';
import { generate } from '../util/ast.js';

export const raw = (ast) => generate(ast, { comments: true, jsescOption: { minimal: true } }).code;

export async function pretty(code) {
  try {
    return await prettier.format(code, {
      parser: 'babel',
      plugins: [babelPlugin, estreePlugin],
      printWidth: 100,
      tabWidth: 2,
      semi: true,
      singleQuote: false,
    });
  } catch {
    return code;
  }
}
