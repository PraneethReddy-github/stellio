import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Real-CLI evals (docs/04 §7). Run through `npm run eval -- <task>`, never as part of `npm test`.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['tests/evals/run.eval.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    disableConsoleIntercept: true,
  },
});
