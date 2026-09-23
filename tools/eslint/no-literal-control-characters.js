/**
 * Ban raw C0 control characters in source files.
 *
 * A literal U+0000 in a string or template literal is legal TypeScript, and Prettier, tsc and
 * every other check in this repository accept it. git does not: it classifies a blob with a NUL
 * in its first 8000 bytes as binary, and a binary blob has no diff, no line-level review comment
 * and no hunk-level merge, so a non-overlapping edit on either side conflicts wholesale. That is
 * how `apps/api/src/middleware/idempotency.ts` reached review in increment 4 as
 * `Bin 0 -> 9233 bytes` with nothing for a reviewer to read.
 *
 * The escape (`'\u0000'`) compiles to the identical string, so there is never a reason to type the
 * byte. Every other C0 control is banned on the same grounds: none of them is distinguishable
 * from a space on screen, and all of them are cheaper to read as an escape.
 *
 * Tab, newline and carriage return are exempt: they are ordinary formatting and Prettier owns
 * them. The rule scans the raw source text rather than string-literal nodes so that a control
 * character in a comment, a JSX text node or a regular expression is caught too.
 *
 * @type {import('eslint').Rule.RuleModule}
 */

/** C0 controls and U+007F, minus tab (09), newline (0A) and carriage return (0D). */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function describe(code) {
  if (code === 0) {
    return 'U+0000 (NUL)';
  }
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

const noLiteralControlCharacters = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw C0 control characters in source text; write them as escapes so git keeps treating the file as text',
    },
    schema: [],
    messages: {
      controlCharacter:
        'Raw control character {{name}} in source. Write it as an escape ("\\u0000"), which compiles to the same value. A raw NUL makes git treat this file as binary, costing it its diff, its review comments and its three-way merge.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const text = context.sourceCode.getText();
        FORBIDDEN.lastIndex = 0;
        let match = FORBIDDEN.exec(text);
        while (match !== null) {
          const index = match.index;
          context.report({
            node,
            loc: {
              start: context.sourceCode.getLocFromIndex(index),
              end: context.sourceCode.getLocFromIndex(index + 1),
            },
            messageId: 'controlCharacter',
            data: { name: describe(text.charCodeAt(index)) },
          });
          match = FORBIDDEN.exec(text);
        }
      },
    };
  },
};

export default noLiteralControlCharacters;
