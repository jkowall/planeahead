// The watchOS shell (increment 11, ADR 0008): a watch app embedded in the iOS app, on the
// variant's App Group (declared in app.config.ts `ios.entitlements`, read here at config time).
// Its bundle id is the app's plus `.watchkitapp`, permanent once a build ships.
//
// `icon` is the variant's app icon (review ruling Z10): App Store Connect wants an app icon asset
// catalog in every app bundle, the embedded watch app included, and without `icon` apple-targets
// writes none (no Assets.car, no CFBundleIconName). It is resolved against this directory, so the
// project-relative path from app.config.ts is prefixed with the way back to the project root.
// apple-targets writes the generated catalog to ./Assets.xcassets on every prebuild, from the
// variant being built; .gitignore and fingerprint.config.js leave that generated copy out.
const path = require('path');

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => {
  if (typeof config.icon !== 'string' || config.icon === '') {
    throw new Error('targets/watch: the app config has no icon for the watch app to carry');
  }
  return {
    type: 'watch',
    name: 'PlaneAheadWatch',
    bundleIdentifier: '.watchkitapp',
    deploymentTarget: '11.0',
    icon: path.posix.join('..', '..', config.icon),
    entitlements: {
      'com.apple.security.application-groups':
        config.ios.entitlements['com.apple.security.application-groups'],
    },
  };
};
