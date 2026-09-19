import { defineConfig } from 'vitest/config';

// Plain node environment on purpose. @cloudflare/vitest-plugin and the Workers pool arrive in
// increment 4, together with Hono and wrangler.jsonc.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
