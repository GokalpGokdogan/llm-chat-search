/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Source files import siblings with a ".js" suffix (ESM style). Map it back to ".ts".
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Unit tests live outside tsconfig "include", so give ts-jest its own settings.
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
};
