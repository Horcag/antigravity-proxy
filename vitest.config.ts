import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  test: {
    maxWorkers: 4,
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    env: {
      AG_PROXY_SOCKET_NAME: 'antigravity-proxy-test-owner',
    },
  },
});
