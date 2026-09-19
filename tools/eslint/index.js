import noModuleScopeDrizzle from './no-module-scope-drizzle.js';

/**
 * Local ESLint plugin. Referenced from eslint.config.js as `planeahead`.
 *
 * @type {import('eslint').ESLint.Plugin}
 */
const plugin = {
  meta: {
    name: 'eslint-plugin-planeahead',
    version: '0.0.0',
  },
  rules: {
    'no-module-scope-drizzle': noModuleScopeDrizzle,
  },
};

export default plugin;
