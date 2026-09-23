import { RuleTester } from 'eslint';
import { test } from 'vitest';
import rule from './no-literal-control-characters.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

/** The byte itself, built at run time so this test file never contains one. */
const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

test('no-literal-control-characters flags raw controls and allows their escapes', () => {
  ruleTester.run('no-literal-control-characters', rule, {
    valid: [
      {
        name: 'the escape, which compiles to the same string',
        code: [
          "const KEY_SEPARATOR = '\\u0000';",
          'export const key = (a, b) => a + KEY_SEPARATOR + b;',
        ].join('\n'),
      },
      {
        name: 'tab, newline and carriage return are ordinary formatting',
        code: 'export const lines = "a\tb";\r\nexport const other = 1;\n',
      },
      {
        name: 'ordinary source with no controls at all',
        code: "export const greeting = 'hello';\n",
      },
    ],
    invalid: [
      {
        name: 'a raw NUL inside a template literal, which is what shipped in increment 4',
        code: `const key = \`\${scope}${NUL}\${value}\`;`,
        errors: [{ messageId: 'controlCharacter', data: { name: 'U+0000 (NUL)' } }],
      },
      {
        name: 'a raw NUL inside a comment counts too',
        code: `// separator: ${NUL}\nexport const x = 1;\n`,
        errors: [{ messageId: 'controlCharacter' }],
      },
      {
        name: 'any other C0 control, not just NUL',
        code: `export const sep = '${UNIT_SEPARATOR}';`,
        errors: [{ messageId: 'controlCharacter', data: { name: 'U+001F' } }],
      },
      {
        name: 'every occurrence is reported, not just the first',
        code: `const a = '${NUL}'; const b = '${NUL}';`,
        errors: [{ messageId: 'controlCharacter' }, { messageId: 'controlCharacter' }],
      },
    ],
  });
});
