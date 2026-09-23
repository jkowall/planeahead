// CommonJS: Jest 29 loads its config with require(). One project on the plain `jest-expo` preset
// (ruling P5, ADR 0001): the store code runs against the in-memory SqliteLike, so the ios and
// android preset pair would only run every file twice.
const { transformIgnorePatterns } = require('jest-expo/jest-preset');

// ESM-only packages the app imports. jest-expo's pattern already lets `.pnpm` paths through at
// the outer node_modules segment; the innermost segment still has to name the package.
const TRANSFORMED_PACKAGES = [
  'better-auth',
  '@better-auth',
  '@better-fetch',
  'better-call',
  'nanostores',
  'hono',
  'drizzle-orm',
];

const [expoPattern, ...rest] = transformIgnorePatterns;
const extended = expoPattern.replace('(?!(', `(?!(${TRANSFORMED_PACKAGES.join('|')}|`);
if (extended === expoPattern) {
  throw new Error(`jest-expo's transformIgnorePatterns changed shape: ${expoPattern}`);
}

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,tsx}'],
  transformIgnorePatterns: [extended, ...rest],
  setupFiles: ['<rootDir>/__tests__/support/setup.ts'],
  clearMocks: true,
  restoreMocks: true,
};
