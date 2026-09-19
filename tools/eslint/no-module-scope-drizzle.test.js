import { RuleTester } from 'eslint';
import { test } from 'vitest';
import rule from './no-module-scope-drizzle.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

test('no-module-scope-drizzle flags module-scope clients and allows per-request clients', () => {
  ruleTester.run('no-module-scope-drizzle', rule, {
    valid: [
      {
        name: 'client created inside a request handler',
        code: [
          "import { drizzle } from 'drizzle-orm/node-postgres';",
          'export default {',
          '  async fetch(request, env, ctx) {',
          '    const db = drizzle(env.DB);',
          '    ctx.waitUntil(db.end());',
          '    return new Response(request.url);',
          '  },',
          '};',
        ].join('\n'),
      },
      {
        name: 'client created inside an arrow function factory',
        code: [
          "import { drizzle } from 'drizzle-orm/node-postgres';",
          'export const withDb = (env) => drizzle(env.DB);',
        ].join('\n'),
      },
      {
        name: 'unrelated module-scope call',
        code: 'const pool = createPool({ max: 1 });',
      },
    ],
    invalid: [
      {
        name: 'client created at module scope',
        code: [
          "import { drizzle } from 'drizzle-orm/node-postgres';",
          'export const db = drizzle(process.env.DATABASE_URL);',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'client created at module scope through a namespace import',
        code: [
          "import * as orm from 'drizzle-orm/node-postgres';",
          'const db = orm.drizzle(process.env.DATABASE_URL);',
          'export { db };',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'client created at module scope inside a block',
        code: [
          "import { drizzle } from 'drizzle-orm/node-postgres';",
          'let db;',
          '{',
          '  db = drizzle(process.env.DATABASE_URL);',
          '}',
          'export { db };',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
    ],
  });
});
