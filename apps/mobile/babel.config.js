// CommonJS: Babel loads this file with require(). babel-preset-expo adds the worklets plugin by
// itself when react-native-worklets is installed.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // drizzle-kit (driver 'expo') writes migrations.js with `import m0000 from './0000_x.sql'`.
      // Inlining the SQL as a string here means Metro never has to resolve a `.sql` module, so
      // metro.config.js stays exactly getSentryExpoConfig(__dirname).
      ['inline-import', { extensions: ['.sql'] }],
    ],
  };
};
