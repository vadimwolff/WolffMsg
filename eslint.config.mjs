// @ts-check
/**
 * ESLint, flat config.
 *
 * The rules here are the ones that would catch a real bug or a real security
 * problem in this codebase. Formatting is left alone: it is not what a linter
 * is for, and a rule that fires on every line trains people to ignore output
 * that also carries the findings that matter.
 *
 * Type-aware rules run on the source of all three packages, which is what
 * makes `no-floating-promises` and `no-misused-promises` possible — the two
 * that catch dropped async work, and dropped async work in a messenger means a
 * message that silently never sent.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/server/prisma/migrations/**',
      // Generated at install time from a dependency's broken ESM entry.
      'scripts/patch-libsodium-esm.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* ── Correctness ─────────────────────────────────────────────────── */

      // An un-awaited promise here is a message that never sent or a key that
      // never rotated, with nothing in the logs to say so.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',

      /*
       * Off deliberately. Fastify route handlers and the no-Redis fallbacks in
       * redis.ts are `async` because their *contract* is to return a promise,
       * not because they happen to await something. Flagging those would mean
       * either weakening the contract or scattering suppressions across every
       * route file.
       */
      '@typescript-eslint/require-await': 'off',

      // `_`-prefixed names are the documented way to say "deliberately unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      /* ── Type safety ─────────────────────────────────────────────────── */

      // Parsed JSON and DB rows are legitimately `any` at the boundary; the
      // schemas that validate them are what make the rest of the code safe, so
      // these warn rather than block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',

      /* ── Security ────────────────────────────────────────────────────── */

      // Every one of these is a way to turn data into code.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      '@typescript-eslint/no-implied-eval': 'error',

      /* ── Habits worth keeping ────────────────────────────────────────── */

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'no-constant-binary-expression': 'error',
    },
  },

  /* ── Web client ──────────────────────────────────────────────────────── */
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      /*
       * The two long-standing hook rules only. Version 7 of this plugin also
       * ships the React Compiler's rules in its `recommended` preset; those
       * assume a codebase compiled by it, and they reject the ordinary
       * "reset this dialog's local state when it reopens" and "subscribe to a
       * media query" patterns this app is built on. Adopting them would mean
       * restructuring working, tested components to satisfy a compiler that is
       * not in use here.
       */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // The store's decrypted message cache and the key vault must never end up
      // in a store that survives sign-out, or that an XSS can read at leisure.
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message:
            'localStorage is readable by any script on the page. Keys go in the ' +
            'IndexedDB vault (crypto/keyVault.ts); only non-secret preferences ' +
            'may use it, and then via an explicit try/catch.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='document'][property.name='write']",
          message: 'document.write is an XSS vector and blocks the parser.',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'Message content is attacker-controlled. Render it as text; use ' +
            'components/Linkify.tsx for links.',
        },
      ],
    },
  },

  /* ── Service worker and other plain browser scripts ──────────────────── */
  {
    files: ['packages/web/public/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
      parserOptions: { projectService: false },
    },
  },

  /* ── Server ──────────────────────────────────────────────────────────── */
  {
    files: ['packages/server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The one place a stack trace or a token could reach stdout unfiltered.
      // Everything goes through the pino logger in logger.ts, which redacts.
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  /* ── Tests ───────────────────────────────────────────────────────────── */
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'packages/server/src/tests/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Reaching into internals is how a test proves an invariant holds.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // A test that plants a value in storage, or feeds a `javascript:` URL to
      // a validator, is exercising the guard rather than evading it.
      'no-restricted-globals': 'off',
      'no-script-url': 'off',
    },
  },

  /* ── Build scripts and config ────────────────────────────────────────── */
  {
    files: [
      'scripts/**/*.mjs',
      'eslint.config.mjs',
      '**/*.config.{js,mjs,ts}',
      '**/prisma.config.ts',
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
);
