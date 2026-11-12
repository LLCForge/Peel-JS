import * as normalize from '../passes/00-normalize.js';
import * as unpack from '../passes/10-unpack-wrapper.js';
import * as predecoders from '../passes/20-predecoders.js';
import * as literals from '../passes/25-literals.js';
import * as constArrays from '../passes/27-const-arrays.js';
import * as constObjects from '../passes/28-const-objects.js';
import * as wrappers from '../passes/29-wrappers.js';
import * as stringArray from '../passes/30-string-array.js';
import * as runtimeDecoders from '../passes/35-runtime-decoders.js';
import * as runtimeFunctions from '../passes/36-runtime-functions.js';
import * as proxy from '../passes/40-proxy.js';
import * as constFold from '../passes/50-const-fold.js';
import * as opaque from '../passes/60-opaque.js';
import * as controlFlow from '../passes/70-control-flow.js';
import * as stateVar from '../passes/74-state-var.js';
import * as vm from '../passes/75-vm.js';
import * as unflatten from '../passes/76-unflatten.js';
import * as deadCode from '../passes/80-dead-code.js';
import * as simplify from '../passes/85-simplify.js';
import * as unused from '../passes/90-unused.js';
import * as rename from '../passes/95-rename.js';
import * as opaqueSmt from '../passes/62-opaque-smt.js';
import * as ssaOpt from '../passes/55-ssa-opt.js';
import * as loopOpt from '../passes/57-loop-opt.js';
import * as specializeFns from '../passes/58-specialize.js';
import * as cfgOpt from '../passes/87-cfg-opt.js';

// Dizi sırası çalışma sırasıdır.
// level: 1=güvenli 2=normal 3=agresif 4=maksimum
// needs: 'sandbox' ise sandbox yokken pass atlanır (diğerleri bağlam varsa onu kullanır, yoksa da çalışır)
export const PASSES = [
  { id: 'normalize',    level: 1, kind: 'text', needs: null,      mod: normalize },
  { id: 'unpack',       level: 1, kind: 'text', needs: null,      mod: unpack },
  { id: 'predecoders',  level: 1, kind: 'text', needs: 'sandbox', mod: predecoders },
  { id: 'literals',     level: 1, kind: 'ast',  needs: null,      mod: literals },
  { id: 'const-arrays', level: 1, kind: 'ast',  needs: null,      mod: constArrays },
  { id: 'const-objects', level: 1, kind: 'ast',  needs: null,      mod: constObjects },
  { id: 'wrappers',     level: 2, kind: 'ast',  needs: null,      mod: wrappers },
  { id: 'string-array', level: 2, kind: 'ast',  needs: 'sandbox', mod: stringArray },
  { id: 'runtime-decoders', level: 2, kind: 'ast', needs: 'sandbox', mod: runtimeDecoders },
  { id: 'runtime-functions', level: 3, kind: 'ast', needs: 'sandbox', mod: runtimeFunctions },
  { id: 'proxy',        level: 2, kind: 'ast',  needs: null,      mod: proxy },
  { id: 'const-fold',   level: 1, kind: 'ast',  needs: 'sandbox', mod: constFold },
  { id: 'dead-code',    level: 2, kind: 'ast',  needs: null,      mod: deadCode },
  { id: 'opaque',       level: 2, kind: 'ast',  needs: null,      mod: opaque },
  { id: 'state-var',    level: 3, kind: 'ast',  needs: null,      mod: stateVar },
  { id: 'unflatten',    level: 3, kind: 'ast',  needs: null,      mod: unflatten },
  { id: 'vm',           level: 3, kind: 'ast',  needs: 'sandbox', mod: vm },
  { id: 'control-flow', level: 3, kind: 'ast',  needs: null,      mod: controlFlow },
  { id: 'simplify',     level: 2, kind: 'ast',  needs: null,      mod: simplify },
  { id: 'unused',       level: 3, kind: 'ast',  needs: null,      mod: unused },
  { id: 'rename',       level: 4, kind: 'ast',  needs: null,      mod: rename },
  // sembolik/derleyici pass'leri (turlar sabit noktaya kadar sürdüğü için sondan da etkili)
  { id: 'opaque-smt',   level: 2, kind: 'ast',  needs: null,      mod: opaqueSmt },
  { id: 'ssa-opt',      level: 3, kind: 'ast',  needs: null,      mod: ssaOpt },
  { id: 'loop-opt',     level: 3, kind: 'ast',  needs: null,      mod: loopOpt },
  { id: 'specialize',   level: 4, kind: 'ast',  needs: null,      mod: specializeFns },
  { id: 'cfg-opt',      level: 3, kind: 'ast',  needs: null,      mod: cfgOpt },
];

export const byId = (id) => PASSES.find((p) => p.id === id);
