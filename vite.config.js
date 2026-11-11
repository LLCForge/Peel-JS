import { defineConfig } from 'vite';

export default defineConfig({
  // @babel/traverse tarayıcıda process.env okuyor
  define: { 'process.env': {} },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['quickjs-emscripten'] },
  build: { target: 'es2022' },
});
