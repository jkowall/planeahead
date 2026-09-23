// CommonJS: the React Native CLI config, which Expo's autolinking loads with require().
//
// @maplibre/maplibre-react-native stays a pinned dependency (the spec's "dependency only") but is
// NOT linked until the maps increment: linked, its Android library merges ACCESS_FINE_LOCATION
// and ACCESS_COARSE_LOCATION into the app's manifest, and its iOS pod calls
// requestWhenInUseAuthorization with no purpose string, while the app declares no location use
// (increment 9 review, expo-correctness-2; ADR 0001). Its config plugin is not listed in
// app.config.ts for the same reason: without the pod, the MapLibre SDK it adds has nothing to
// build. The maps increment deletes this entry, lists the plugin and declares location.
module.exports = {
  dependencies: {
    '@maplibre/maplibre-react-native': {
      platforms: { ios: null, android: null },
    },
  },
};
