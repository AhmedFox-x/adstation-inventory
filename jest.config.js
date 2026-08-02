module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  testTimeout: 120000,
  globalSetup: '<rootDir>/jest.global-setup.ts',
  maxWorkers: 1,
};
