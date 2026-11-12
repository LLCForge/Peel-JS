import { defineConfig } from 'vite';

// H168: peel-js kütüphanesinin tek dosyalık, bağımsız ESM paketi (npm gerektirmez).
// QuickJS WASM ve isteğe bağlı javascript-obfuscator dahil her şey tek dosyaya gömülür; böylece
// Observable notebook'u dosyayı FileAttachment olarak ekleyip import() ile yükleyebilir.
// Çıktı: extensions/observable/dist/peel.js  (npm run build:lib)
export default defineConfig({
  define: { 'process.env': {} },
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'extensions/observable/dist',
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: 'src/index.js',
      formats: ['es'],
      fileName: () => 'peel.js',
    },
    rollupOptions: {
      // obfuscator'ın tarayıcı derlemesi `self` bekliyor; modül kapsamında tanımlanır ki paket Node/worker'da da yüklensin
      output: { inlineDynamicImports: true, banner: 'const self = globalThis;' },
    },
  },
});
