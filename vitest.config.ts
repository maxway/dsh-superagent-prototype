import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  // The Windows CI runner is a shared workstation: process/PowerShell-heavy suites can starve another test file.
  // Keep the default fast locally, but give every test and hook enough room there instead of failing on a slow answer.
  test: { include: ['tests/**/*.spec.{ts,tsx}'], testTimeout: 20_000, hookTimeout: 20_000 },
})
