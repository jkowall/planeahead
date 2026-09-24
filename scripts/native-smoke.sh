#!/usr/bin/env bash
# Native smoke (increment 11, ADR 0008): every step of .github/workflows/native-smoke.yml, in one
# script, so the nightly and a developer on a Mac run the same commands.
#
#   scripts/native-smoke.sh ios-prebuild      expo prebuild, then the generated entitlements
#   scripts/native-smoke.sh ios-build         xcodebuild Release for an iPhone simulator
#   scripts/native-smoke.sh ios-archive       the .app holds the widget extension (and watch shells)
#   scripts/native-smoke.sh ios-launch        install, launch, still alive after the grace period
#   scripts/native-smoke.sh android-prebuild  expo prebuild, then the Wear module's inclusion
#   scripts/native-smoke.sh android-build     gradle assembleDebug (the app and the Wear module)
#   scripts/native-smoke.sh android-archive   the APKs and the ongoing-notification stub
#   scripts/native-smoke.sh android-launch    install, launch, still alive (needs a running device)
#
# The PRODUCTION variant with the production EAS profile's APNS_ENVIRONMENT, so the entitlements
# asserted are the ones a store build signs (ruling V3). Launching is the point: a dyld failure
# (a framework embedded in the wrong bundle) builds clean and dies at launch (facts section 5,
# apple-targets issue 194), so a compile alone proves little.
#
# Inputs (environment): SMOKE_DERIVED_DATA (Xcode's derived data, default apps/mobile/ios/build),
# SMOKE_SIMULATOR (a simulator UDID; default: an iPhone on the newest iOS runtime),
# SMOKE_GRACE_SECONDS (default 30), SMOKE_ANDROID_ABIS (default: every ABI a store build has),
# SMOKE_GRADLE_JVMARGS (default -Xmx4g: the template's 2 GB ran D8 out of heap on a cold build).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_DIR="$REPO_ROOT/apps/mobile"

export APP_VARIANT=production
export APNS_ENVIRONMENT=production
export EXPO_NO_GIT_STATUS=1
export EXPO_NO_TELEMETRY=1
export SENTRY_DISABLE_AUTO_UPLOAD=true
export LANG="${LANG:-en_US.UTF-8}"
unset PLANEAHEAD_ANDROID_WIDGETS

BUNDLE_ID=app.planeahead.mobile
APP_GROUP="group.$BUNDLE_ID"
PROJECT=PlaneAhead
DERIVED_DATA="${SMOKE_DERIVED_DATA:-$APP_DIR/ios/build}"
GRACE_SECONDS="${SMOKE_GRACE_SECONDS:-30}"
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphonesimulator/$PROJECT.app"

fail() {
  echo "native-smoke: FAIL: $*" >&2
  exit 1
}

expect_equal() {
  local label="$1" actual="$2" expected="$3"
  [ "$actual" = "$expected" ] || fail "$label is '$actual', expected '$expected'"
  echo "native-smoke: ok: $label = $expected"
}

# A plist value by PlistBuddy key path (`:a:0`): plutil's dotted key paths cannot name keys that
# contain dots, such as com.apple.security.application-groups.
plist_value() {
  /usr/libexec/PlistBuddy -c "Print $2" "$1" 2>/dev/null || true
}

watch_shells_expected() {
  [ -f "$APP_DIR/targets/watch/expo-target.config.js" ]
}

pick_simulator() {
  if [ -n "${SMOKE_SIMULATOR:-}" ]; then
    echo "$SMOKE_SIMULATOR"
    return
  fi
  xcrun simctl list devices available -j | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
      const runtimes = Object.entries(JSON.parse(raw).devices)
        .filter(([runtime]) => runtime.includes("SimRuntime.iOS-"))
        .sort(([a], [b]) => {
          const version = (id) => id.split("iOS-")[1].split("-").map(Number);
          const [x, y] = [version(a), version(b)];
          return y[0] - x[0] || (y[1] ?? 0) - (x[1] ?? 0);
        });
      for (const [, devices] of runtimes) {
        const phone = devices.find((device) => device.name.startsWith("iPhone"));
        if (phone) {
          console.log(phone.udid);
          return;
        }
      }
      process.exit(1);
    });
  ' || fail "no available iPhone simulator"
}

ios_prebuild() {
  cd "$APP_DIR"
  pnpm exec expo prebuild --platform ios
  local entitlements="ios/$PROJECT/$PROJECT.entitlements"
  expect_equal "aps-environment (app)" \
    "$(plist_value "$entitlements" :aps-environment)" production
  expect_equal "App Group (app)" \
    "$(plist_value "$entitlements" :com.apple.security.application-groups:0)" "$APP_GROUP"
  expect_equal "App Group (widget extension)" \
    "$(plist_value ios/ExpoWidgetsTarget/ExpoWidgetsTarget.entitlements \
      :com.apple.security.application-groups:0)" "$APP_GROUP"
  # A corrupt project file from two pbxproj writers shows here, not in an exit status.
  local targets
  targets="$(xcodebuild -list -project "ios/$PROJECT.xcodeproj" | sed -n '/Targets:/,/^$/p')"
  echo "$targets"
  for target in "$PROJECT" ExpoWidgetsTarget; do
    grep -qx "        $target" <<<"$targets" || fail "target $target missing from the project"
  done
  if watch_shells_expected; then
    for target in PlaneAheadWatch PlaneAheadWatchWidget; do
      grep -qx "        $target" <<<"$targets" || fail "target $target missing from the project"
      expect_equal "App Group ($target)" \
        "$(plist_value "ios/.targets/$target/generated.entitlements" \
          :com.apple.security.application-groups:0)" "$APP_GROUP"
    done
  fi
}

ios_build() {
  cd "$APP_DIR"
  local simulator
  simulator="$(pick_simulator)"
  # Only -destination, never -sdk iphonesimulator: -sdk forces EVERY target onto the iOS SDK, and
  # the watch shells would then build for the iOS simulator instead of watchOS (spike 2).
  # ONLY_ACTIVE_ARCH=YES: Release otherwise compiles an x86_64 slice as well, which no Apple
  # silicon simulator runs, doubling the build.
  xcodebuild -workspace "ios/$PROJECT.xcworkspace" -scheme "$PROJECT" -configuration Release \
    -destination "platform=iOS Simulator,id=$simulator" -derivedDataPath "$DERIVED_DATA" \
    ONLY_ACTIVE_ARCH=YES build
}

platform_of() {
  vtool -show-build "$1" | awk '/platform/ { print $2; exit }'
}

ios_archive() {
  [ -d "$APP_PATH" ] || fail "no app at $APP_PATH"
  local widgets="$APP_PATH/PlugIns/ExpoWidgetsTarget.appex"
  [ -d "$widgets" ] || fail "the expo-widgets extension is not in the app"
  [ -f "$widgets/ExpoWidgets.bundle/ExpoWidgets.bundle" ] ||
    fail "the widget runtime bundle is not in the extension"
  expect_equal "widget extension bundle id" \
    "$(plist_value "$widgets/Info.plist" :CFBundleIdentifier)" "$BUNDLE_ID.widgets"
  expect_equal "widget extension App Group" \
    "$(plist_value "$widgets/Info.plist" :ExpoWidgetsAppGroupIdentifier)" "$APP_GROUP"
  if watch_shells_expected; then
    local watch="$APP_PATH/Watch/PlaneAheadWatch.app"
    [ -d "$watch" ] || fail "the watch app is not in the app"
    [ -d "$watch/PlugIns/PlaneAheadWatchWidget.appex" ] || fail "the watch widget is not embedded"
    expect_equal "watch app platform" "$(platform_of "$watch/PlaneAheadWatch")" WATCHOSSIMULATOR
    expect_equal "watch widget platform" \
      "$(platform_of "$watch/PlugIns/PlaneAheadWatchWidget.appex/PlaneAheadWatchWidget")" \
      WATCHOSSIMULATOR
  fi
  expect_equal "app platform" "$(platform_of "$APP_PATH/$PROJECT")" IOSSIMULATOR
}

ios_launch() {
  local simulator pid alive
  simulator="$(pick_simulator)"
  xcrun simctl boot "$simulator" 2>/dev/null || true
  xcrun simctl bootstatus "$simulator" -b
  xcrun simctl uninstall "$simulator" "$BUNDLE_ID" || true
  xcrun simctl install "$simulator" "$APP_PATH"
  pid="$(xcrun simctl launch "$simulator" "$BUNDLE_ID" | awk '{ print $2 }')"
  echo "native-smoke: launched $BUNDLE_ID as pid $pid; waiting ${GRACE_SECONDS}s"
  sleep "$GRACE_SECONDS"
  alive="$(xcrun simctl spawn "$simulator" launchctl list |
    awk -v label="UIKitApplication:${BUNDLE_ID}[" 'index($3, label) == 1 { print $1 }')"
  if [ "$alive" != "$pid" ]; then
    xcrun simctl spawn "$simulator" log show --last 2m --style compact \
      --predicate "process == \"$PROJECT\"" | tail -50 || true
    fail "$BUNDLE_ID is not running ${GRACE_SECONDS}s after launch (pid now '${alive:-none}')"
  fi
  echo "native-smoke: ok: $BUNDLE_ID alive after ${GRACE_SECONDS}s (pid $pid)"
}

android_prebuild() {
  cd "$APP_DIR"
  pnpm exec expo prebuild --platform android --no-install
  grep -qx "include ':wear'" android/settings.gradle || fail "the Wear module is not included"
  [ -f android/wear/build.gradle ] || fail "android/wear/build.gradle was not generated"
  if grep -q 'android.appwidget.provider' android/app/src/main/AndroidManifest.xml; then
    fail "an Android widget receiver is in the manifest, but enableAndroid is off by default"
  fi
  echo "native-smoke: ok: Wear module included, no Android widget receiver"
}

android_build() {
  cd "$APP_DIR/android"
  local abis=()
  if [ -n "${SMOKE_ANDROID_ABIS:-}" ]; then
    abis=("-PreactNativeArchitectures=$SMOKE_ANDROID_ABIS")
  fi
  ./gradlew assembleDebug --console=plain \
    "-Dorg.gradle.jvmargs=${SMOKE_GRADLE_JVMARGS:--Xmx4g -XX:MaxMetaspaceSize=1g}" ${abis[@]+"${abis[@]}"}
}

android_archive() {
  cd "$APP_DIR"
  local app=android/app/build/outputs/apk/debug/app-debug.apk
  local wear=android/wear/build/outputs/apk/debug/wear-debug.apk
  [ -f "$app" ] || fail "no $app"
  [ -f "$wear" ] || fail "no $wear"
  # The stub module's class is in the app's dex (a descriptor string, so a byte count finds it;
  # `grep -c` reads to the end, where `grep -q` would SIGPIPE unzip under pipefail).
  [ "$(unzip -p "$app" 'classes*.dex' | LC_ALL=C grep -ac 'Lapp/planeahead/surfaces/OngoingNotificationModule;')" -gt 0 ] ||
    fail "the ongoing-notification module is not in the app"
  [ "$(unzip -p "$wear" 'classes*.dex' | LC_ALL=C grep -ac 'Lapp/planeahead/wear/NextFlightTileService;')" -gt 0 ] ||
    fail "the Tile service is not in the Wear APK"
  echo "native-smoke: ok: app and Wear APKs built, stub module and Tile compiled in"
}

android_launch() {
  cd "$APP_DIR"
  local pid
  adb wait-for-device
  adb install -r android/app/build/outputs/apk/debug/app-debug.apk
  adb shell monkey -p "$BUNDLE_ID" -c android.intent.category.LAUNCHER 1
  echo "native-smoke: launched $BUNDLE_ID; waiting ${GRACE_SECONDS}s"
  sleep "$GRACE_SECONDS"
  pid="$(adb shell pidof "$BUNDLE_ID" | tr -d '\r' || true)"
  if [ -z "$pid" ]; then
    adb logcat -d -t 200 | grep -iE 'AndroidRuntime|FATAL|planeahead' | tail -50 || true
    fail "$BUNDLE_ID is not running ${GRACE_SECONDS}s after launch"
  fi
  echo "native-smoke: ok: $BUNDLE_ID alive after ${GRACE_SECONDS}s (pid $pid)"
}

case "${1:-}" in
  ios-prebuild) ios_prebuild ;;
  ios-build) ios_build ;;
  ios-archive) ios_archive ;;
  ios-launch) ios_launch ;;
  android-prebuild) android_prebuild ;;
  android-build) android_build ;;
  android-archive) android_archive ;;
  android-launch) android_launch ;;
  *)
    sed -n '2,13p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
