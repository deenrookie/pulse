import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies API/SSE to the Go backend; the Host header is rewritten
// (changeOrigin) to satisfy the backend's host validation.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
