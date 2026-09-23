import noLiteralControlCharacters from './no-literal-control-characters.js';
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
    'no-literal-control-characters': noLiteralControlCharacters,
    'no-module-scope-drizzle': noModuleScopeDrizzle,
  },
};

export default plugin;
