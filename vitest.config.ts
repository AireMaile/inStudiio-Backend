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
          // Requires a running local Supabase (supabase start).
          include: ['tests/**/*.int.test.ts'],
        },
      },
    ],
  },
});
