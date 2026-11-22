import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  workers: 1,
  // One retry, with a trace, so a rare stall shows up as "flaky" with evidence instead of hiding or blocking.
  retries: 1,
  use: { trace: 'on-first-retry' },
  reporter: [['list']],
});
