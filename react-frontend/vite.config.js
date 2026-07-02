import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // API calls use relative /api/* URLs so the same build works on CloudFront
  // (where CloudFront routes /api/* to API Gateway). Locally, proxy /api to
  // the FastAPI dev server on :8000.
  server: {
    // Allow importing `../docs/USER_GUIDE.md?raw` (the file is outside the
    // react-frontend root so we widen Vite's fs allowlist to the repo root).
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
