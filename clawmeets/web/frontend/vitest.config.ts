import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Test-only config. The production `tsc && vite build` excludes *.test.tsx (see
// tsconfig.json), so tests never enter the shipped bundle. Vitest transforms via
// esbuild and does its own module resolution — this config just supplies the
// React plugin + a jsdom environment for the auth-store / callback tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
