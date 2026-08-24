import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base must match the GitHub Pages subpath (https://<user>.github.io/NamR/).
// Override with VITE_BASE=/ when serving from a custom domain or root.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/NamR/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
