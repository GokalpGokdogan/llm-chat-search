const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Chat log formats are untyped JSON from third-party tools.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
