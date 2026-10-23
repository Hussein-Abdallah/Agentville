import { defineConfig } from 'vite';

// In dev (`npm run dev`), forward live data to the service started with `npm run serve`.
export default defineConfig({
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4917', ws: true },
      '/health': 'http://127.0.0.1:4917',
      '/auth': 'http://127.0.0.1:4917',
      '/events': 'http://127.0.0.1:4917',
    },
  },
});
