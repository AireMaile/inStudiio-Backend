import { defineConfig, configDefaults } from 'vitest/config';

// Shared per-project settings. With `projects`, options like include/
// setupFiles live inside each project, not at the top level.
const shared = {
  environment: 'node' as const,
  globals: false,
  setupFiles: ['tests/setup.ts'],
  testTimeout: 10_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          // *.int.test.ts also matches *.test.ts, so exclude it here.
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/**/*.int.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          // Reconciliation workers intentionally claim global due work. Run
          // integration files serially so one test file cannot lease another
          // file's fixture while still preserving concurrency inside tests.
          fileParallelism: false,
          // Requires a running local Supabase (supabase start).
          include: ['tests/**/*.int.test.ts'],
        },
      },
    ],
  },
});
