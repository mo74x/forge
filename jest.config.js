/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  moduleNameMapper: {
    '^@lattice/([^/]+)/(.*)$': '<rootDir>/libs/$1/src/$2',
    '^@lattice/(.*)$': '<rootDir>/libs/$1/src',
  },
};
