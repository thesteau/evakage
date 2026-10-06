import globals from 'globals';
import tseslint from 'typescript-eslint';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Flat config. Three environments in one repo: the Node server, the browser
// client, and the Node test suite (which also uses browser globals, because it
// drives WebSocket and fetch).
export default [
  {
    ignores: ['node_modules/**', 'dist/**', '**/*.tmp.mjs', '**/*.cts', 'app/client/assets/**', 'test-results/**', 'playwright-report/**']
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module'
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      // Correctness.
      'no-undef': 'error',
      // ignoreRestSiblings: `const { secret, ...rest } = obj` is how a field is
      // deliberately stripped, and the stripped name is meant to go unused.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-implicit-globals': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'require-atomic-updates': 'off',
      'no-await-in-loop': 'off',

      // The empty catch block is a deliberate idiom here: best-effort cleanup
      // and optional browser APIs. Require it to be genuinely empty, though.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Style, kept to what actually prevents bugs.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-return-await': 'error',
      'no-useless-escape': 'error',
      'no-useless-concat': 'error',
      'no-useless-return': 'error',
      'no-else-return': ['error', { allowElseIf: true }],
      'dot-notation': 'error',
      'no-lonely-if': 'error',
      curly: ['error', 'multi-line'],

      // Guard against the prototype-chain lookup bug the fuzzer found.
      'no-prototype-builtins': 'error',
      'guard-for-in': 'error'
    }
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  },
  {
    // The signaling server and its modules.
    files: ['app/server/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // The browser client. WebSocket/fetch/crypto come from the browser set.
    files: ['app/client/ts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    // The service worker has its own global scope.
    files: ['app/client/ts/sw.ts'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser }
    }
  },
  {
    // Tests run in Node but exercise the browser-shaped globals Node now ships.
    files: ['tests/unit/**/*.ts', 'tests/e2e/**/*.ts', 'tests/release/**/*.cts', 'scripts/**/*.cts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
].map(config => ({ ...config, basePath: repositoryRoot }));
