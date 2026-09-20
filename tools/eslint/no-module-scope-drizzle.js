/**
 * Ban `drizzle(...)` and `postgres(...)` at module scope.
 *
 * The Workers runtime rule is one database client per request or queue batch. A client created
 * at module scope is shared across requests inside an isolate and outlives the request that
 * opened it, which leaks Hyperdrive connections. `drizzle()` is only a wrapper: the call that
 * opens the pool is `postgres(url, options)`, so the rule bans both. Creating the client inside
 * a function (a handler, the `withDb` helper, a factory) is the supported shape; on the
 * Hyperdrive path nothing calls `end()`, Hyperdrive reclaims the connection when the invocation
 * ends (ADR 0009).
 *
 * The postgres.js default import can be bound to any local name (`import pg from 'postgres'`),
 * so the rule tracks the names each module binds to that package as well as the literal names
 * `drizzle` and `postgres`.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const noModuleScopeDrizzle = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calling drizzle() or postgres() at module scope; create the client per request or queue batch',
    },
    schema: [],
    messages: {
      moduleScope:
        'Do not create a database client at module scope. Create it inside the request or queue handler (withDb), never as a shared module-level value.',
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

    /** Local names bound to the postgres.js default export in this module. */
    const clientFactoryNames = new Set(['drizzle', 'postgres']);

    /**
     * @param {import('estree').Node} node
     * @returns {boolean}
     */
    function isClientFactoryCallee(node) {
      if (node.type === 'Identifier') {
        return clientFactoryNames.has(node.name);
      }
      if (
        node.type === 'MemberExpression' &&
        !node.computed &&
        node.property.type === 'Identifier'
      ) {
        return node.property.name === 'drizzle' || node.property.name === 'postgres';
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'postgres') {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportDefaultSpecifier' ||
            (specifier.type === 'ImportSpecifier' &&
              specifier.imported.type === 'Identifier' &&
              specifier.imported.name === 'default')
          ) {
            clientFactoryNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (!isClientFactoryCallee(node.callee)) {
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
