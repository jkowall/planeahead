// The watch-face complication shell (increment 11, ADR 0008), embedded in the watch app, on the
// variant's App Group. Its bundle id is the app's plus `.watchkitapp.widget`.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'watch-widget',
  name: 'PlaneAheadWatchWidget',
  bundleIdentifier: '.watchkitapp.widget',
  deploymentTarget: '11.0',
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
