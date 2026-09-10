import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // 本地 npm run dev 时把 API 与探针代理到本机服务（8090）
    proxy: {
      '/v1': 'http://127.0.0.1:8090',
      '/healthz': 'http://127.0.0.1:8090',
    },
  },
});
