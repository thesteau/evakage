import globals from 'globals';

// Flat config. Three environments in one repo: the Node server, the browser
// client, and the Node test suite (which also uses browser globals, because it
// drives WebSocket and fetch).
export default [
  {
    ignores: ['node_modules/**', 'public/icons/**']
  },
  {
    files: ['**/*.js'],
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
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
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
    // The signaling server and its modules.
    files: ['server.js', 'blobstore.js'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // The browser client. WebSocket/fetch/crypto come from the browser set.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    // The service worker has its own global scope.
    files: ['public/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser }
    }
  },
  {
    // Tests run in Node but exercise the browser-shaped globals Node now ships.
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, WebSocket: 'readonly', fetch: 'readonly' }
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
];
