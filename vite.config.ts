import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Two pages: the app at / and the static explainer at /why.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        why: resolve(import.meta.dirname, 'why.html'),
      },
    },
  },
});
