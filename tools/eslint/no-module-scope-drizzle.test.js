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
          "import { drizzle } from 'drizzle-orm/postgres-js';",
          "import postgres from 'postgres';",
          'export default {',
          '  async fetch(request, env) {',
          '    const db = drizzle(postgres(env.DB.connectionString, { max: 5 }));',
          '    return new Response(request.url);',
          '  },',
          '};',
        ].join('\n'),
      },
      {
        name: 'client created inside an arrow function factory',
        code: [
          "import { drizzle } from 'drizzle-orm/postgres-js';",
          "import postgres from 'postgres';",
          'export const withDb = (env) => drizzle(postgres(env.DB.connectionString));',
        ].join('\n'),
      },
      {
        name: 'aliased postgres.js import used inside a function',
        code: [
          "import pg from 'postgres';",
          'export function createNodeDb(url) {',
          '  return pg(url, { max: 1 });',
          '}',
        ].join('\n'),
      },
      {
        name: 'unrelated module-scope call',
        code: 'const pool = createPool({ max: 1 });',
      },
    ],
    invalid: [
      {
        name: 'drizzle client created at module scope',
        code: [
          "import { drizzle } from 'drizzle-orm/postgres-js';",
          'export const db = drizzle(process.env.DATABASE_URL);',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'drizzle client created at module scope through a namespace import',
        code: [
          "import * as orm from 'drizzle-orm/postgres-js';",
          'const db = orm.drizzle(process.env.DATABASE_URL);',
          'export { db };',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'drizzle client created at module scope inside a block',
        code: [
          "import { drizzle } from 'drizzle-orm/postgres-js';",
          'let db;',
          '{',
          '  db = drizzle(process.env.DATABASE_URL);',
          '}',
          'export { db };',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'postgres.js pool created at module scope and wrapped lazily',
        code: [
          "import { drizzle } from 'drizzle-orm/postgres-js';",
          "import postgres from 'postgres';",
          'const client = postgres(process.env.DATABASE_URL);',
          'export function db() {',
          '  return drizzle(client);',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'postgres.js pool created at module scope through an aliased default import',
        code: [
          "import pg from 'postgres';",
          'export const client = pg(process.env.DATABASE_URL);',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
      {
        name: 'postgres.js pool created at module scope through a namespace import',
        code: [
          "import * as pgjs from 'postgres';",
          'export const client = pgjs.postgres(process.env.DATABASE_URL);',
        ].join('\n'),
        errors: [{ messageId: 'moduleScope' }],
      },
    ],
  });
});
