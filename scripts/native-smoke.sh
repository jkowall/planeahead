#!/usr/bin/env bash
# Native smoke (increment 11, ADR 0008): every step of .github/workflows/native-smoke.yml, in one
# script, so the scheduled workflow and a developer on a Mac run the same commands.
#
#   scripts/native-smoke.sh ios-prebuild      expo prebuild, the entitlements and build settings
#   scripts/native-smoke.sh ios-build         xcodebuild Release for an iPhone simulator
#   scripts/native-smoke.sh ios-archive       the .app holds the widget extension (and watch shells)
#   scripts/native-smoke.sh ios-launch        install, launch, still alive after the grace period
#   scripts/native-smoke.sh ios-device-archive  unsigned Release archive for a device, its bundles
#   scripts/native-smoke.sh android-prebuild  expo prebuild, then the Wear module's inclusion
#   scripts/native-smoke.sh android-build     gradle assembleDebug and assembleRelease
#   scripts/native-smoke.sh android-archive   the APKs, the manifest, permissions, 16 KB pages
#   scripts/native-smoke.sh android-launch    install the release APK, launch, alive, no JS fatal
#   scripts/native-smoke.sh disk-guard N WHAT  fail unless N GB are free (before the emulator)
#
# What the store accepts (increment 13, rulings S2 to S5): ios-archive and ios-device-archive fail
# unless every .app and .appex in the app carries a privacy manifest that declares each
# required-reason API its executable references, and the app's version and build number;
# android-archive fails unless the release APK and its 64-bit libraries suit 16 KB memory pages.
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
# SMOKE_ARCHIVE_PATH (the device archive, default PlaneAhead.xcarchive in the derived data),
# SMOKE_ARCHIVE_MIN_FREE_GB (the room the device archive must have before it starts; default 5 GB,
# twice what it wrote locally, 0 skips the check),
# SMOKE_SIMULATOR (a simulator UDID; default: an iPhone on the newest iOS runtime),
# SMOKE_GRACE_SECONDS (default 30), SMOKE_ANDROID_ABIS (default: every ABI a store build has; the
# workflow builds x86_64 only, the emulator's), SMOKE_BUILD_MIN_FREE_GB (the room the Android build
# must have before it starts; default 10 GB plus 5 per ABI, 0 skips the check for an incremental
# rebuild), SMOKE_GRADLE_JVMARGS (default -Xmx4g: the template's 2 GB ran D8 out of heap on a cold
# build),
# ANDROID_HOME (or ANDROID_SDK_ROOT; the android-archive step runs its build-tools' aapt2 and
# zipalign and its NDK's llvm-readelf).
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
ARCHIVE_PATH="${SMOKE_ARCHIVE_PATH:-$DERIVED_DATA/$PROJECT.xcarchive}"
GRACE_SECONDS="${SMOKE_GRACE_SECONDS:-30}"
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

# Apple's required-reason APIs as the undefined symbols (`nm -u`) of an executable that calls them
# (ruling S2): one entry per category, the category first, then its symbols. App Store Connect
# refuses an app whose executables use one without a declared reason in their own bundle's privacy
# manifest (R5 F11, F12). The APIs are Apple's list, 2026-09-30
# (https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype):
# the C functions by name (`$INODE64` variants match their base name), the Foundation keys by
# their constants, UserDefaults by its class. getattrlist and its two relatives are in both the
# file timestamp and the disk space lists, and either declaration covers them. Selector-only APIs
# (ProcessInfo.systemUptime, UIDocument.fileModificationDate, UITextInputMode.activeInputModes,
# the whole active keyboards category) leave no undefined symbol, so nothing here can see them.
# shellcheck disable=SC2016 # `$` is part of the Objective-C class symbol, not an expansion.
REQUIRED_REASON_SYMBOLS=(
  'NSPrivacyAccessedAPICategoryFileTimestamp
    _stat _stat64 _fstat _fstat64 _lstat _lstat64 _fstatat _fstatat64
    _getattrlist _fgetattrlist _getattrlistat _getattrlistbulk
    _NSFileCreationDate _NSFileModificationDate
    _NSURLContentModificationDateKey _NSURLCreationDateKey'
  'NSPrivacyAccessedAPICategorySystemBootTime
    _mach_absolute_time'
  'NSPrivacyAccessedAPICategoryDiskSpace
    _statfs _statfs64 _statvfs _fstatfs _fstatfs64 _fstatvfs
    _getattrlist _fgetattrlist _getattrlistat
    _NSFileSystemFreeSize _NSFileSystemSize
    _NSURLVolumeAvailableCapacityKey _NSURLVolumeAvailableCapacityForImportantUsageKey
    _NSURLVolumeAvailableCapacityForOpportunisticUsageKey _NSURLVolumeTotalCapacityKey'
  'NSPrivacyAccessedAPICategoryUserDefaults
    _OBJC_CLASS_$_NSUserDefaults'
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
  local manifests=(ExpoWidgetsTarget)
  if watch_shells_expected; then
    for target in PlaneAheadWatch PlaneAheadWatchWidget; do
      grep -qx "        $target" <<<"$targets" || fail "target $target missing from the project"
      expect_equal "App Group ($target)" \
        "$(plist_value "ios/.targets/$target/generated.entitlements" \
          :com.apple.security.application-groups:0)" "$APP_GROUP"
    done
    manifests+=(PlaneAheadWatch PlaneAheadWatchWidget)
  fi
  # Each extension's own privacy manifest (plugins/withExtensionPrivacyManifests.ts, ruling S1);
  # ios-archive proves each lands in its own bundle.
  for target in "${manifests[@]}"; do
    plutil -lint -s "ios/$target/PrivacyInfo.xcprivacy" ||
      fail "ios/$target/PrivacyInfo.xcprivacy is missing or does not parse"
  done
  echo "native-smoke: ok: privacy manifests written for ${manifests[*]}"
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
  check_store_bundles "$APP_PATH"
}

# What App Store Connect checks of every bundle in APP, the app itself included (rulings S2 and
# S3): each .app and .appex carries a PrivacyInfo.xcprivacy that parses, gives each category it
# declares a reason, and declares every required-reason API its executable's undefined symbols
# name; and each has the app's CFBundleShortVersionString and CFBundleVersion.
check_store_bundles() {
  local app="$1" version build bundles bundle label manifest executable symbols undeclared
  local categories category i
  version="$(plist_value "$app/Info.plist" :CFBundleShortVersionString)"
  build="$(plist_value "$app/Info.plist" :CFBundleVersion)"
  [ -n "$version" ] && [ -n "$build" ] || fail "$app/Info.plist has no version or build number"
  bundles="$(find "$app" \( -name '*.app' -o -name '*.appex' \) -type d | LC_ALL=C sort)"
  while IFS= read -r bundle; do
    label="${bundle#"$(dirname "$app")/"}"
    manifest="$bundle/PrivacyInfo.xcprivacy"
    [ -f "$manifest" ] || fail "$label carries no PrivacyInfo.xcprivacy"
    plutil -lint -s "$manifest" || fail "$label: its PrivacyInfo.xcprivacy does not parse"
    categories=()
    i=0
    while category="$(plutil -extract "NSPrivacyAccessedAPITypes.$i.NSPrivacyAccessedAPIType" \
      raw -o - "$manifest" 2>/dev/null)"; do
      plutil -extract "NSPrivacyAccessedAPITypes.$i.NSPrivacyAccessedAPITypeReasons.0" \
        raw -o - "$manifest" >/dev/null 2>&1 || fail "$label declares $category without a reason"
      categories+=("$category")
      i=$((i + 1))
    done
    executable="$bundle/$(plist_value "$bundle/Info.plist" :CFBundleExecutable)"
    symbols="$(nm -u "$executable")" || fail "nm could not read $executable"
    undeclared="$(undeclared_required_reasons ${categories[@]+"${categories[@]}"} <<<"$symbols")"
    if [ -n "$undeclared" ]; then
      echo "$undeclared" >&2
      fail "$label calls required-reason APIs its privacy manifest does not declare" \
        "(each symbol, then its categories, above)"
    fi
    echo "native-smoke: ok: $label's privacy manifest declares" \
      "${categories[*]:-no required-reason API}, all its executable needs"
    expect_equal "$label CFBundleShortVersionString" \
      "$(plist_value "$bundle/Info.plist" :CFBundleShortVersionString)" "$version"
    expect_equal "$label CFBundleVersion" "$(plist_value "$bundle/Info.plist" :CFBundleVersion)" \
      "$build"
  done <<<"$bundles"
}

# `nm -u` output on stdin, the categories a privacy manifest declares as arguments; prints one line
# per required-reason symbol (REQUIRED_REASON_SYMBOLS) the executable references and none of whose
# categories is declared: the symbol, then its categories. Each symbol once, however many
# architectures list it.
undeclared_required_reasons() {
  # One line, entries separated by `|`: the macOS awk also splits a string at every newline.
  local table
  table="$(printf '%s|' "${REQUIRED_REASON_SYMBOLS[@]}" | tr '\n' ' ')"
  TABLE="$table" DECLARED="$(printf '%s ' "$@")" awk '
    BEGIN {
      entries = split(ENVIRON["TABLE"], entry, "|")
      for (e = 1; e <= entries; e++) {
        fields = split(entry[e], field, " ")
        for (f = 2; f <= fields; f++) {
          if (field[f] in categories) categories[field[f]] = categories[field[f]] " " field[1]
          else categories[field[f]] = field[1]
        }
      }
      count = split(ENVIRON["DECLARED"], name, " ")
      for (d = 1; d <= count; d++) {
        if (name[d] != "") declared[name[d]] = 1
      }
    }
    NF > 0 {
      symbol = $1
      sub(/\$INODE64$/, "", symbol)
      if (!(symbol in categories) || (symbol in seen)) next
      seen[symbol] = 1
      covered = 0
      total = split(categories[symbol], candidate, " ")
      for (c = 1; c <= total; c++) {
        if (candidate[c] in declared) covered = 1
      }
      if (!covered) print symbol, categories[symbol]
    }
  '
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

# The store build is a device build (ruling S4): the simulator build above never compiles for the
# device SDKs (arm64 for the app and the extension, the watchOS device slices for the watch
# shells) and never archives. An unsigned Release archive for generic/platform=iOS does both
# without an Apple team; ios-archive's store checks then run on the archived app. It shares the
# derived data with ios-build, whose module cache it reuses, and adds about 2.5 GB to it.
ios_device_archive() {
  cd "$APP_DIR"
  local app="$ARCHIVE_PATH/Products/Applications/$PROJECT.app" watch
  disk_guard "${SMOKE_ARCHIVE_MIN_FREE_GB:-5}" "the device archive"
  rm -rf "$ARCHIVE_PATH"
  xcodebuild archive -workspace "ios/$PROJECT.xcworkspace" -scheme "$PROJECT" \
    -configuration Release -destination 'generic/platform=iOS' -archivePath "$ARCHIVE_PATH" \
    -derivedDataPath "$DERIVED_DATA" CODE_SIGNING_ALLOWED=NO
  [ -d "$app" ] || fail "the archive holds no app at $app"
  expect_equal "archived app platform" "$(platform_of "$app/$PROJECT")" IOS
  expect_equal "archived widget extension platform" \
    "$(platform_of "$app/PlugIns/ExpoWidgetsTarget.appex/ExpoWidgetsTarget")" IOS
  if watch_shells_expected; then
    watch="$app/Watch/PlaneAheadWatch.app"
    expect_equal "archived watch app platform" "$(platform_of "$watch/PlaneAheadWatch")" WATCHOS
    expect_equal "archived watch widget platform" \
      "$(platform_of "$watch/PlugIns/PlaneAheadWatchWidget.appex/PlaneAheadWatchWidget")" WATCHOS
  fi
  check_store_bundles "$app"
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

# Whole gigabytes available on the filesystem that holds the current directory: `df -P` prints the
# same columns on Linux and macOS, the fourth being the space available in 1024-byte blocks. (On
# APFS it leaves purgeable space out, so a Mac reads low, never high.)
free_gb() {
  df -Pk . | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

# Fails unless NEED whole gigabytes are free before WHAT (0 skips the check). A step that fills
# the disk takes a hosted runner down with it, and the runner then uploads no log at all (every
# scheduled run from 2026-09-24 to 2026-09-29), so the steps that write gigabytes check first.
disk_guard() {
  local need="$1" what="$2" room
  [[ "$need" =~ ^[0-9]+$ ]] ||
    fail "the room to check before ${what} must be whole gigabytes, not '${need}'"
  room="$(free_gb)"
  [[ "$room" =~ ^[0-9]+$ ]] || fail "could not read the free space before ${what} from df"
  if [ "$need" -gt 0 ] && [ "$room" -lt "$need" ]; then
    fail "only ${room} GB free before ${what}, which needs about ${need} GB"
  fi
  echo "native-smoke: ${room} GB free before ${what}"
}

android_build() {
  cd "$APP_DIR/android"
  local abis=() listed=() count=4 rc=0
  if [ -n "${SMOKE_ANDROID_ABIS:-}" ]; then
    abis=("-PreactNativeArchitectures=$SMOKE_ANDROID_ABIS")
    IFS=, read -r -a listed <<<"$SMOKE_ANDROID_ABIS"
    count="${#listed[@]}"
  fi
  # Build output measured on 2026-09-30: 5.8 GB for x86_64 alone, 18.1 GB for all four ABIs, so
  # about 5 GB an ABI plus room for Gradle's caches and an NDK download.
  disk_guard "${SMOKE_BUILD_MIN_FREE_GB:-$((10 + 5 * count))}" \
    "the Android build (ABIs: ${SMOKE_ANDROID_ABIS:-all})"
  # assembleDebug is the compile the spec names; assembleRelease embeds the JavaScript bundle the
  # launch step needs (review ruling Z5), signed with the template's debug keystore. The space left
  # is reported whether or not the build succeeds; a failed build keeps its exit code.
  ./gradlew assembleDebug assembleRelease --console=plain \
    "-Dorg.gradle.jvmargs=${SMOKE_GRADLE_JVMARGS:--Xmx4g -XX:MaxMetaspaceSize=1g}" ${abis[@]+"${abis[@]}"} || rc=$?
  echo "native-smoke: $(free_gb) GB free after the Android build"
  return "$rc"
}

android_sdk() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  [ -n "$sdk" ] || fail "ANDROID_HOME (or ANDROID_SDK_ROOT) is not set"
  echo "$sdk"
}

# A tool of the newest build-tools of the SDK the build used: aapt2, or zipalign (whose -P option,
# the 16 KB check, came with build-tools 35).
build_tool() {
  local sdk tools
  sdk="$(android_sdk)"
  tools="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
  [ -x "$tools/$1" ] || fail "no $1 in $sdk/build-tools"
  echo "$tools/$1"
}

# llvm-readelf of the newest NDK in the SDK (the Android build installs the NDK it compiles with).
ndk_readelf() {
  local sdk tool
  sdk="$(android_sdk)"
  tool="$(find "$sdk/ndk" -path '*/toolchains/llvm/prebuilt/*/bin/llvm-readelf' 2>/dev/null |
    sort -V | tail -1)"
  [ -n "$tool" ] || fail "no llvm-readelf in an NDK under $sdk/ndk"
  echo "$tool"
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
  aapt2="$(build_tool aapt2)"
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

  check_page_alignment "$APK_RELEASE"
}

# 16 KB memory pages (ruling S5; R5 G9 to G11): Play requires apps with native code targeting
# Android 15 or newer to support them, and from 2027-02-01 refuses a non-compliant update. Both of
# Google's checks (https://developer.android.com/guide/practices/page-sizes): the APK's stored
# libraries start on 16 KB boundaries (zipalign -c -P 16), and every LOAD segment of every 64-bit
# library is aligned to at least 16 KB (llvm-readelf -l). 32-bit libraries are exempt.
check_page_alignment() {
  local apk="$1" zipalign readelf report libs abi abis=() so headers misaligned="" count=0
  [ -f "$apk" ] || fail "no APK at '$apk'"
  zipalign="$(build_tool zipalign)"
  mkdir -p "$APP_DIR/android/app/build"
  report="$APP_DIR/android/app/build/zipalign.txt"
  if ! "$zipalign" -c -P 16 -v 4 "$apk" >"$report" 2>&1; then
    grep -v '(OK' "$report" | tail -20 >&2 || true
    fail "$apk is not aligned for 16 KB pages (zipalign -c -P 16 -v 4)"
  fi
  echo "native-smoke: ok: zipalign -c -P 16 -v 4 verifies $apk"
  readelf="$(ndk_readelf)"
  libs="$APP_DIR/android/app/build/native-smoke-libs"
  rm -rf "$libs"
  mkdir -p "$libs"
  unzip -q -o "$apk" 'lib/*' -d "$libs" || fail "unzip found no native library in $apk"
  for abi in arm64-v8a x86_64; do
    if [ -d "$libs/lib/$abi" ]; then
      abis+=("$libs/lib/$abi")
    fi
  done
  [ "${#abis[@]}" -gt 0 ] || fail "$apk carries no 64-bit native library to check"
  while IFS= read -r so; do
    [ -n "$so" ] || continue
    count=$((count + 1))
    headers="$("$readelf" -lW "$so")" || fail "llvm-readelf could not read ${so#"$libs"/}"
    if [ -n "$(elf_load_misaligned <<<"$headers")" ]; then
      echo "${so#"$libs"/}:" >&2
      elf_load_misaligned <<<"$headers" >&2
      misaligned="$misaligned ${so#"$libs"/}"
    fi
  done <<<"$(find "${abis[@]}" -name '*.so' | LC_ALL=C sort)"
  [ "$count" -gt 0 ] || fail "$apk carries no 64-bit native library to check"
  [ -z "$misaligned" ] ||
    fail "64-bit libraries with a LOAD segment aligned below 16 KB (0x4000):$misaligned"
  echo "native-smoke: ok: all $count 64-bit libraries in $apk align every LOAD segment to 16 KB"
}

# `llvm-readelf -lW` output on stdin; prints each LOAD program header whose alignment (the last
# column) is below 16 KB, 0x4000, and "no LOAD segment" when there is none, so output that is not
# a readable program header table never passes.
elf_load_misaligned() {
  awk '
    function hex(text,   i, digit, value) {
      text = tolower(text)
      if (substr(text, 1, 2) != "0x" || length(text) < 3) return -1
      value = 0
      for (i = 3; i <= length(text); i++) {
        digit = index("0123456789abcdef", substr(text, i, 1)) - 1
        if (digit < 0) return -1
        value = value * 16 + digit
      }
      return value
    }
    $1 == "LOAD" {
      loads++
      if (hex($NF) < 16384) print
    }
    END { if (loads == 0) print "no LOAD segment" }
  '
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
  ios-device-archive) ios_device_archive ;;
  android-prebuild) android_prebuild ;;
  android-build) android_build ;;
  android-archive) android_archive ;;
  android-launch) android_launch ;;
  # The workflow runs this before the emulator step, which downloads its system image.
  disk-guard) disk_guard "${2:-}" "${3:-the next step}" ;;
  # Internal, for tools/workflows/native-smoke.test.js: the classifiers, on stdin
  # (undeclared-reasons takes the categories a manifest declares as arguments), and
  # android-archive's 16 KB check on any APK.
  logcat-errors) logcat_errors ;;
  permissions-differ) permissions_differ ;;
  undeclared-reasons) undeclared_required_reasons "${@:2}" ;;
  elf-load-misaligned) elf_load_misaligned ;;
  page-alignment) check_page_alignment "${2:-}" ;;
  *)
    sed -n '2,19p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
