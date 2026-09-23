// Metro auto-configures for monorepos since SDK 52 (no watchFolders, no nodeModulesPaths). The
// whole config is Sentry's wrapper around Expo's default, which adds the debug ids the source-map
// upload matches on (docs/increments/09-11-mobile.facts.md section 1).
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname);
