import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '.claude/',
      'out/',
      'dist/',
      'release/',
      'node_modules/',
      'spikes/',
      'coverage/',
      'test-results/',
      'playwright-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The renderer must never reach into the main process directly.
      'no-restricted-imports': ['error', { patterns: ['**/main/**', 'electron', 'node:*'] }],
    },
  },
  {
    // Shared code is bundled into the renderer: no Electron, no Node, no main-process imports.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/main/**', '**/renderer/**', 'electron', 'node:*'] },
      ],
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['**/main/**', '**/renderer/**', 'node:*'] }] },
  },
  {
    files: ['src/main/platform/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  {
    // Command-line tools: they print their result, and the perf run evaluates code inside the renderer page.
    files: ['scripts/**/*.mjs', 'tests/perf/**/*.mjs', 'tests/packaging/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },
);
