import { defineConfig } from 'drizzle-kit';

// Generates SQL only; our own migrator (migrate.ts) applies it. Run:
//   npx drizzle-kit generate --config src/main/db/drizzle.config.ts
// then rename the output to `NNNN_name.sql` and delete the `meta/` folder.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
});
