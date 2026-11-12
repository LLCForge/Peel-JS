import * as normalize from '../passes/00-normalize.js';
import * as unpack from '../passes/10-unpack-wrapper.js';
import * as predecoders from '../passes/20-predecoders.js';
import * as literals from '../passes/25-literals.js';
import * as iifeArgs from '../passes/26-iife-args.js';
import * as constArrays from '../passes/27-const-arrays.js';
import * as constObjects from '../passes/28-const-objects.js';
import * as wrappers from '../passes/29-wrappers.js';
import * as stringArray from '../passes/30-string-array.js';
import * as runtimeDecoders from '../passes/35-runtime-decoders.js';
import * as runtimeFunctions from '../passes/36-runtime-functions.js';
import * as evalInline from '../passes/37-eval-inline.js';
import * as rgf from '../passes/38-rgf.js';
import * as varMask from '../passes/46-var-mask.js';
import * as flatFns from '../passes/47-flat-fns.js';
import * as dispatcher from '../passes/48-dispatcher.js';
import * as proxy from '../passes/40-proxy.js';
import * as constFold from '../passes/50-const-fold.js';
import * as opaque from '../passes/60-opaque.js';
import * as controlFlow from '../passes/70-control-flow.js';
import * as stateVar from '../passes/74-state-var.js';
import * as vm from '../passes/75-vm.js';
import * as unflatten from '../passes/76-unflatten.js';
import * as deadCode from '../passes/80-dead-code.js';
import * as locks from '../passes/82-locks.js';
import * as simplify from '../passes/85-simplify.js';
import * as unused from '../passes/90-unused.js';
import * as webpack from '../passes/93-webpack.js';
import * as rename from '../passes/95-rename.js';

// Dizi sırası çalışma sırasıdır.
// level: 1=güvenli 2=normal 3=agresif 4=maksimum
// needs: 'sandbox' ise sandbox yokken pass atlanır (diğerleri bağlam varsa onu kullanır, yoksa da çalışır)
export const PASSES = [
  { id: 'normalize',    level: 1, kind: 'text', needs: null,      mod: normalize },
  { id: 'unpack',       level: 1, kind: 'text', needs: null,      mod: unpack },
  { id: 'predecoders',  level: 1, kind: 'text', needs: 'sandbox', mod: predecoders },
  // integrity kilidi fonksiyon metninin özetine bakar: metni değiştiren her pass'ten önce açılmalı
  { id: 'locks',        level: 2, kind: 'ast',  needs: null,      mod: locks },
  { id: 'literals',     level: 1, kind: 'ast',  needs: null,      mod: literals },
  { id: 'iife-args',    level: 2, kind: 'ast',  needs: null,      mod: iifeArgs },
  { id: 'const-arrays', level: 1, kind: 'ast',  needs: null,      mod: constArrays },
  { id: 'const-objects', level: 1, kind: 'ast',  needs: null,      mod: constObjects },
  { id: 'wrappers',     level: 2, kind: 'ast',  needs: null,      mod: wrappers },
  { id: 'string-array', level: 2, kind: 'ast',  needs: 'sandbox', mod: stringArray },
  { id: 'runtime-decoders', level: 2, kind: 'ast', needs: 'sandbox', mod: runtimeDecoders },
  { id: 'runtime-functions', level: 3, kind: 'ast', needs: 'sandbox', mod: runtimeFunctions },
  { id: 'eval-inline',  level: 2, kind: 'ast',  needs: null,      mod: evalInline },
  { id: 'rgf',          level: 2, kind: 'ast',  needs: null,      mod: rgf },
  { id: 'proxy',        level: 2, kind: 'ast',  needs: null,      mod: proxy },
  { id: 'var-mask',     level: 2, kind: 'ast',  needs: null,      mod: varMask },
  { id: 'flat-fns',     level: 2, kind: 'ast',  needs: null,      mod: flatFns },
  { id: 'dispatcher',   level: 2, kind: 'ast',  needs: null,      mod: dispatcher },
  { id: 'const-fold',   level: 1, kind: 'ast',  needs: 'sandbox', mod: constFold },
  { id: 'dead-code',    level: 2, kind: 'ast',  needs: null,      mod: deadCode },
  { id: 'opaque',       level: 2, kind: 'ast',  needs: null,      mod: opaque },
  { id: 'state-var',    level: 3, kind: 'ast',  needs: null,      mod: stateVar },
  { id: 'unflatten',    level: 3, kind: 'ast',  needs: null,      mod: unflatten },
  { id: 'vm',           level: 3, kind: 'ast',  needs: 'sandbox', mod: vm },
  { id: 'control-flow', level: 3, kind: 'ast',  needs: null,      mod: controlFlow },
  { id: 'simplify',     level: 2, kind: 'ast',  needs: null,      mod: simplify },
  { id: 'unused',       level: 3, kind: 'ast',  needs: null,      mod: unused },
  { id: 'webpack',      level: 2, kind: 'ast',  needs: null,      mod: webpack },
  { id: 'rename',       level: 4, kind: 'ast',  needs: null,      mod: rename },
];

export const byId = (id) => PASSES.find((p) => p.id === id);
