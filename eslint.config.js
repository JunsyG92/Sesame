import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import nodePlugin from 'eslint-plugin-n';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeFiles = [
  'src/main/**/*.ts',
  'src/preload/**/*.ts',
  'tests/unit/main/**/*.ts',
  'tests/helpers/**/*.ts',
  'tests/e2e/**/*.ts',
  'scripts/**/*.{js,mjs,cjs}',
  '*.config.{js,mjs,ts}',
];
const reactFiles = ['src/renderer/**/*.{ts,tsx}', 'tests/unit/renderer/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          minimumDescriptionLength: 10,
        },
      ],
      // Type assertions hide errors: `as const` stays allowed, anything else needs
      // an explicit, justified eslint-disable comment.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: 'error',
      // Both rules flag every computed member access / every non-literal path, which
      // is the nature of a file-based store. Paths are validated by `store/paths.ts`
      // (unit + property tested) and indexed access is covered by
      // `noUncheckedIndexedAccess`.
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: nodeFiles,
    extends: [nodePlugin.configs['flat/recommended-module']],
    languageOptions: { globals: globals.node },
    rules: {
      // Module resolution is checked by TypeScript (bundler resolution, no extensions).
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-process-exit': 'error',
      // Electron's runtime ships its own Node.js; `engines` only describes tooling.
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  {
    files: reactFiles,
    extends: [
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.strict,
    ],
    languageOptions: { globals: globals.browser },
    settings: { react: { version: '19' } },
    rules: {
      'react/prop-types': 'off',
      // The launcher is a focused single-purpose window: moving focus to its
      // search field on open is the expected behaviour (like Spotlight).
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/unbound-method': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
