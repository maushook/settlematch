import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Served at https://maushook.com/settlematch/. App code builds every URL from import.meta.env.BASE_URL.
  base: '/settlematch/',
  build: {
    rollupOptions: {
      // Two pages: the app at /settlematch/ and the static explainer at /settlematch/why.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        why: resolve(import.meta.dirname, 'why.html'),
      },
    },
  },
});
