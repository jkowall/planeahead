/**
 * Ban `drizzle(...)` at module scope.
 *
 * The Workers runtime rule is one database client per request or queue batch, closed via
 * `ctx.waitUntil`. A client created at module scope is shared across requests inside an isolate
 * and outlives the request that opened it, which leaks Hyperdrive connections. Creating it inside
 * a function (a handler, a `withDb` helper, a factory) is the supported shape.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const noModuleScopeDrizzle = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calling drizzle() at module scope; create the client per request or queue batch',
    },
    schema: [],
    messages: {
      moduleScope:
        'Do not call drizzle() at module scope. Create the client inside the request or queue handler and close it with ctx.waitUntil.',
    },
  },
  create(context) {
    /** Function-like nodes that make a call "not module scope". */
    const functionTypes = new Set([
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'StaticBlock',
    ]);

    /**
     * @param {import('estree').Node} node
     * @returns {boolean}
     */
    function isDrizzleCallee(node) {
      if (node.type === 'Identifier') {
        return node.name === 'drizzle';
      }
      if (
        node.type === 'MemberExpression' &&
        !node.computed &&
        node.property.type === 'Identifier'
      ) {
        return node.property.name === 'drizzle';
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isDrizzleCallee(node.callee)) {
          return;
        }
        const ancestors = context.sourceCode.getAncestors(node);
        if (ancestors.some((ancestor) => functionTypes.has(ancestor.type))) {
          return;
        }
        context.report({ node, messageId: 'moduleScope' });
      },
    };
  },
};

export default noModuleScopeDrizzle;
