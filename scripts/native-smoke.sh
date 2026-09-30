#!/usr/bin/env bash
# Native smoke (increment 11, ADR 0008): every step of .github/workflows/native-smoke.yml, in one
# script, so the scheduled workflow and a developer on a Mac run the same commands.
#
#   scripts/native-smoke.sh ios-prebuild      expo prebuild, the entitlements and build settings
#   scripts/native-smoke.sh ios-build         xcodebuild Release for an iPhone simulator
#   scripts/native-smoke.sh ios-archive       the .app holds the widget extension (and watch shells)
#   scripts/native-smoke.sh ios-launch        install, launch, still alive after the grace period
#   scripts/native-smoke.sh android-prebuild  expo prebuild, then the Wear module's inclusion
#   scripts/native-smoke.sh android-build     gradle assembleDebug and assembleRelease
#   scripts/native-smoke.sh android-archive   the APKs, the stub, the manifest and its permissions
#   scripts/native-smoke.sh android-launch    install the release APK, launch, alive, no JS fatal
#
# The PRODUCTION variant with the production EAS profile's APNS_ENVIRONMENT, so the entitlements
# asserted are the ones a store build signs (ruling V3). Launching is the point: a dyld failure
# (a framework embedded in the wrong bundle) builds clean and dies at launch (facts section 5,
# apple-targets issue 194), so a compile alone proves little.
#
# Android launches the RELEASE build (review ruling Z5): the debug APK embeds no JavaScript (it
# is the dev launcher, which waits for Metro), so launching it proved only the native shell. The
# release APK carries the bundle and, as the template has it, is signed with the debug keystore,
# so it installs on an emulator; a JavaScript fatal at startup shows as a dead process or as a
# FATAL EXCEPTION or ReactNativeJS error in logcat, and either fails the step.
#
# Inputs (environment): SMOKE_DERIVED_DATA (Xcode's derived data, default apps/mobile/ios/build),
# SMOKE_SIMULATOR (a simulator UDID; default: an iPhone on the newest iOS runtime),
# SMOKE_GRACE_SECONDS (default 30), SMOKE_ANDROID_ABIS (default: every ABI a store build has; the
# workflow builds x86_64 only, the emulator's), SMOKE_MIN_FREE_GB (default 15: the room the Android
# build must have before it starts), SMOKE_GRADLE_JVMARGS (default -Xmx4g: the template's 2 GB ran
# D8 out of heap on a cold build),
# ANDROID_HOME (or ANDROID_SDK_ROOT; the android-archive step runs its build-tools' aapt2).
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
MIN_FREE_GB="${SMOKE_MIN_FREE_GB:-15}"
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphonesimulator/$PROJECT.app"
APK_DEBUG=android/app/build/outputs/apk/debug/app-debug.apk
APK_RELEASE=android/app/build/outputs/apk/release/app-release.apk
APK_WEAR=android/wear/build/outputs/apk/debug/wear-debug.apk

# Every permission the production Android app declares, and nothing else (review rulings Z3 and
# Z11): a dependency that merges a new one into the manifest (expo-widgets' WorkManager brought
# FOREGROUND_SERVICE) fails android-archive until it is either blocked in app.config.ts or added
# here on purpose, with the privacy answers checked. The list is the release APK's as of the
# increment 11 review round, by where the manifest merger's report says each comes from; none
# comes from increment 11.
EXPECTED_ANDROID_PERMISSIONS=(
  # The template, Sentry and expo-updates: the network.
  android.permission.INTERNET
  android.permission.ACCESS_NETWORK_STATE
  # expo-network (increment 9).
  android.permission.ACCESS_WIFI_STATE
  # The template.
  android.permission.VIBRATE
  # expo-notifications and Firebase Cloud Messaging (increment 9).
  android.permission.POST_NOTIFICATIONS
  android.permission.RECEIVE_BOOT_COMPLETED
  android.permission.WAKE_LOCK
  com.google.android.c2dm.permission.RECEIVE
  # androidx.core's guard for receivers registered at runtime.
  "$BUNDLE_ID.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
  # The Play install referrer library.
  com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE
  # ShortcutBadger, through expo-notifications (launcher badge counts).
  android.permission.READ_APP_BADGE
  com.anddoes.launcher.permission.UPDATE_COUNT
  com.htc.launcher.permission.READ_SETTINGS
  com.htc.launcher.permission.UPDATE_SHORTCUT
  com.huawei.android.launcher.permission.CHANGE_BADGE
  com.huawei.android.launcher.permission.READ_SETTINGS
  com.huawei.android.launcher.permission.WRITE_SETTINGS
  com.majeur.launcher.permission.UPDATE_BADGE
  com.oppo.launcher.permission.READ_SETTINGS
  com.oppo.launcher.permission.WRITE_SETTINGS
  com.sec.android.provider.badge.permission.READ
  com.sec.android.provider.badge.permission.WRITE
  com.sonyericsson.home.permission.BROADCAST_BADGE
  com.sonymobile.home.permission.PROVIDER_INSERT_BADGE
  me.everything.badger.permission.BADGE_COUNT_READ
  me.everything.badger.permission.BADGE_COUNT_WRITE
)

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
  # expo-widgets writes -Onone into the extension's Release configuration, which also turns on
  # the debug dylib; plugins/withExpoWidgetsBuild.ts corrects both (review ruling Z11).
  local settings
  settings="$(xcodebuild -showBuildSettings -project "ios/$PROJECT.xcodeproj" \
    -target ExpoWidgetsTarget -configuration Release 2>/dev/null)"
  expect_equal "ExpoWidgetsTarget Release SWIFT_OPTIMIZATION_LEVEL" \
    "$(build_setting SWIFT_OPTIMIZATION_LEVEL <<<"$settings")" -O
  expect_equal "ExpoWidgetsTarget Release ENABLE_DEBUG_DYLIB" \
    "$(build_setting ENABLE_DEBUG_DYLIB <<<"$settings")" NO
}

# One value from `xcodebuild -showBuildSettings` on stdin.
build_setting() {
  awk -v key="$1" '$1 == key && $2 == "=" { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }'
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
    # App Store Connect wants an app icon catalog in every app bundle, the watch app's included
    # (review ruling Z10); apple-targets writes one only when the target config names an icon.
    # actool records it where it does for the iOS app, under CFBundleIcons.
    expect_equal "watch app CFBundleIconName" \
      "$(plist_value "$watch/Info.plist" :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName)" \
      AppIcon
    [ -f "$watch/Assets.car" ] || fail "the watch app has no compiled asset catalog (Assets.car)"
    echo "native-smoke: ok: the watch app carries its icon catalog"
  fi
  expect_equal "app platform" "$(platform_of "$APP_PATH/$PROJECT")" IOSSIMULATOR
  # A Release app carries no debug dylib: expo-widgets' generated -Onone Release configuration
  # put ExpoWidgetsTarget.debug.dylib and __preview.dylib into the extension (review ruling Z11).
  local debug_dylibs
  debug_dylibs="$(find "$APP_PATH" \( -name '*.debug.dylib' -o -name '__preview.dylib' \) -print)"
  if [ -n "$debug_dylibs" ]; then
    echo "$debug_dylibs" >&2
    fail "the Release app carries debug dylibs"
  fi
  echo "native-smoke: ok: no debug dylib in the Release app"
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

# Whole gigabytes available on the filesystem that holds the current directory (POSIX df, so the
# same on Linux and macOS).
free_gb() {
  df -Pk . | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

android_build() {
  cd "$APP_DIR/android"
  local abis=() room
  if [ -n "${SMOKE_ANDROID_ABIS:-}" ]; then
    abis=("-PreactNativeArchitectures=$SMOKE_ANDROID_ABIS")
  fi
  # A build that fills the disk takes a hosted runner down with it, and the runner then uploads no
  # log at all (every scheduled run from 2026-09-24 to 2026-09-29), so refuse to start without room.
  room="$(free_gb)"
  [ "$room" -ge "$MIN_FREE_GB" ] ||
    fail "only ${room} GB free before the Android build, which needs about ${MIN_FREE_GB} GB (SMOKE_MIN_FREE_GB)"
  echo "native-smoke: ${room} GB free before the Android build (ABIs: ${SMOKE_ANDROID_ABIS:-all})"
  # assembleDebug is the compile the spec names; assembleRelease embeds the JavaScript bundle the
  # launch step needs (review ruling Z5), signed with the template's debug keystore.
  ./gradlew assembleDebug assembleRelease --console=plain \
    "-Dorg.gradle.jvmargs=${SMOKE_GRADLE_JVMARGS:--Xmx4g -XX:MaxMetaspaceSize=1g}" ${abis[@]+"${abis[@]}"}
  echo "native-smoke: $(free_gb) GB free after the Android build"
}

# The newest build-tools' aapt2 of the SDK the build used.
aapt2_bin() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" tools
  [ -n "$sdk" ] || fail "ANDROID_HOME (or ANDROID_SDK_ROOT) is not set"
  tools="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
  [ -x "$tools/aapt2" ] || fail "no aapt2 in $sdk/build-tools"
  echo "$tools/aapt2"
}

android_archive() {
  cd "$APP_DIR"
  local apk aapt2 manifest
  for apk in "$APK_DEBUG" "$APK_RELEASE" "$APK_WEAR"; do
    [ -f "$apk" ] || fail "no $apk"
  done
  # The stub module's class is in the app's dex (a descriptor string, so a byte count finds it;
  # `grep -c` reads to the end, where `grep -q` would SIGPIPE unzip under pipefail).
  [ "$(unzip -p "$APK_DEBUG" 'classes*.dex' | LC_ALL=C grep -ac 'Lapp/planeahead/surfaces/OngoingNotificationModule;')" -gt 0 ] ||
    fail "the ongoing-notification module is not in the app"
  [ "$(unzip -p "$APK_WEAR" 'classes*.dex' | LC_ALL=C grep -ac 'Lapp/planeahead/wear/NextFlightTileService;')" -gt 0 ] ||
    fail "the Tile service is not in the Wear APK"
  echo "native-smoke: ok: app and Wear APKs built, stub module and Tile compiled in"

  # The release APK runs the app's JavaScript, which the launch step relies on (ruling Z5).
  unzip -l "$APK_RELEASE" | awk '{ print $4 }' | grep -qx 'assets/index.android.bundle' ||
    fail "the release APK embeds no JavaScript bundle"
  echo "native-smoke: ok: the release APK embeds index.android.bundle"

  # expo-widgets stays out of Android autolinking while its widgets are off, and with it Glance
  # and WorkManager (their receivers, services, startup initializer and FOREGROUND_SERVICE).
  aapt2="$(aapt2_bin)"
  for apk in "$APK_DEBUG" "$APK_RELEASE"; do
    manifest="$("$aapt2" dump xmltree --file AndroidManifest.xml "$apk")"
    if grep -E 'androidx\.(work|glance)' <<<"$manifest"; then
      fail "$apk: the merged manifest carries WorkManager or Glance components"
    fi
  done
  echo "native-smoke: ok: no WorkManager or Glance component in the merged manifests"

  # The production manifest's permissions are exactly the expected list.
  "$aapt2" dump permissions "$APK_RELEASE" >"$APP_DIR/android/app/build/permissions.txt"
  permissions_differ <"$APP_DIR/android/app/build/permissions.txt" &&
    fail "the release APK's permissions differ from the expected list (< expected, > actual)"
  echo "native-smoke: ok: the release APK declares exactly the expected permissions"
}

# `aapt2 dump permissions` output on stdin; prints a diff and succeeds when the declared
# permissions are not exactly EXPECTED_ANDROID_PERMISSIONS. Both forms count: aapt2 prints a
# `<uses-permission-sdk-23>` on its own `uses-permission-sdk-23:` line, and with minSdk 24 such a
# permission is as real as a plain one on every supported device (increment 11 re-review).
permissions_differ() {
  local actual expected
  actual="$(sed -n "s/^uses-permission\(-sdk-23\)\{0,1\}: name='\([^']*\)'.*/\2/p" | LC_ALL=C sort -u)"
  expected="$(printf '%s\n' "${EXPECTED_ANDROID_PERMISSIONS[@]}" | LC_ALL=C sort -u)"
  [ "$actual" != "$expected" ] || return 1
  diff <(echo "$expected") <(echo "$actual") >&2 || true
}

# `adb logcat -v brief` on stdin; prints each line that fails the launch: a FATAL EXCEPTION
# whose next lines name this app's process, and any ReactNativeJS error. A fatal in another
# process (an emulator's system app) is not the app's.
logcat_errors() {
  awk -v app="Process: $BUNDLE_ID," '
    /FATAL EXCEPTION/ { fatal = $0; next }
    fatal != "" && index($0, app) > 0 { print fatal; print; fatal = ""; next }
    { fatal = "" }
    /^E\/ReactNativeJS/ { print }
  '
}

android_launch() {
  cd "$APP_DIR"
  local pid errors
  adb wait-for-device
  # The release APK (ruling Z5): it runs the embedded JavaScript, where the debug APK would only
  # show the dev launcher. Uninstall first: a debug build signed differently would refuse -r.
  adb uninstall "$BUNDLE_ID" >/dev/null 2>&1 || true
  adb install -r "$APK_RELEASE"
  adb logcat -c || true
  adb shell monkey -p "$BUNDLE_ID" -c android.intent.category.LAUNCHER 1
  echo "native-smoke: launched $BUNDLE_ID (release); waiting ${GRACE_SECONDS}s"
  sleep "$GRACE_SECONDS"
  pid="$(adb shell pidof "$BUNDLE_ID" | tr -d '\r' || true)"
  # A JavaScript fatal kills the process with a FATAL EXCEPTION naming it; an error the app
  # survives still logs at ReactNativeJS error level. Only this app logs ReactNativeJS.
  errors="$(adb logcat -d -v brief 'AndroidRuntime:E' 'ReactNativeJS:E' '*:S' | logcat_errors)"
  if [ -z "$pid" ] || [ -n "$errors" ]; then
    echo "$errors" >&2
    adb logcat -d -t 300 | grep -iE 'AndroidRuntime|FATAL|ReactNativeJS|planeahead' | tail -80 >&2 || true
    [ -n "$pid" ] || fail "$BUNDLE_ID is not running ${GRACE_SECONDS}s after launch"
    fail "$BUNDLE_ID logged a fatal or a JavaScript error within ${GRACE_SECONDS}s of launch"
  fi
  echo "native-smoke: ok: $BUNDLE_ID alive after ${GRACE_SECONDS}s (pid $pid), no fatal, no JS error"
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
  # Internal, for tools/workflows/native-smoke.test.js: the two classifiers, on stdin.
  logcat-errors) logcat_errors ;;
  permissions-differ) permissions_differ ;;
  *)
    sed -n '2,13p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
