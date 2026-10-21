import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing.html'),
        // The public agent pages (/users/:account/agents/…): no auth, no app shell.
        public: resolve(__dirname, 'public.html'),
        tos: resolve(__dirname, 'tos.html'),
        // The hub operator terms (--accept-tos), served at /hub/terms.
        'hub-terms': resolve(__dirname, 'hub-terms.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        'private-beta-announcement': resolve(
          __dirname,
          'private-beta-announcement.html',
        ),
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4567',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: 'ws://localhost:4567',
        ws: true,
      },
    },
  },
})
