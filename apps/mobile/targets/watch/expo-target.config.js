// The watchOS shell (increment 11, ADR 0008): a watch app embedded in the iOS app, on the
// variant's App Group (declared in app.config.ts `ios.entitlements`, read here at config time).
// Its bundle id is the app's plus `.watchkitapp`, permanent once a build ships.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'watch',
  name: 'PlaneAheadWatch',
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '11.0',
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
