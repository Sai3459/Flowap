// `defineConfig` comes from vitest/config rather than vite: it is vite's own, re-exported with
// the `test` block added to the config type. Importing it from 'vite' leaves `test` unknown and
// `tsc -b` rejects this file.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-support/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
