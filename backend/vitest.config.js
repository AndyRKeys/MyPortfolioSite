import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV:   'test',
      JWT_SECRET: 'test-secret-for-vitest',
    },
    exclude: ['**/node_modules/**', '**/tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['middleware/**', 'routes/**', 'utils/**'],
      exclude: ['tests/**'],
    },
  },
});
