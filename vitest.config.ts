import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./src/test/vscodeMock.ts', import.meta.url)),
    },
  },
  test: {
    // Pure logic only — these tests never touch the VS Code API, so the default
    // node environment is enough (and fast). Scope to *.test.ts under src/.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
