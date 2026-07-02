import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Multiple test files share one Postgres test DB and TRUNCATE it in
    // resetDb(); running files in parallel races those truncations against
    // concurrent inserts in other files. Serialize file execution instead.
    fileParallelism: false,
  },
});
