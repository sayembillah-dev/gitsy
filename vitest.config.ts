import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Core purity rule (section 2): /src/core is tested in Node with zero mocking.
// No React plugin here on purpose: headless first (section 0, rule 2).
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
