// CommonJS: @expo/fingerprint loads this file with require(), in every process that resolves the
// fingerprint runtime version: the EAS builder, `eas update` (through `expo-updates
// runtimeversion:resolve`) and a local `pnpm exec expo-updates runtimeversion:resolve`.
//
// Two jobs: add the native sources @expo/fingerprint does not find on its own, and leave out the
// files a build has and an update does not.
//
// Extra sources (increment 11 review, ruling Z9). The fingerprint hashes the app config, the
// plugins it names and the autolinked modules' native directories, but not two directories of
// hand-written native code the config plugins only point at: targets/ (the watchOS shells'
// Swift and Info.plist files, which @bacons/apple-targets compiles) and wear/ (the Wear OS
// module's Kotlin and resources, which plugins/withWearApp.ts compiles). Without them a change
// to the watch complication's Swift reader kept the runtime version, so an update published with
// a matching JavaScript change would reach older builds whose Swift expects the old format.
// Inside targets/, the asset catalog apple-targets generates on every prebuild from the variant's
// icon (targets/watch/Assets.xcassets, gitignored) is left out: it exists on a builder after
// prebuild but never under `eas update`, and the icon it comes from is already in the config.
//
// Why: the runtime version is the fingerprint of the resolved app config, the external files it
// names included, and `eas update --environment <env>` can read only the EAS variables with Plain
// text or Sensitive visibility: never a FILE variable, never a Secret. `GOOGLE_SERVICES_JSON` is a
// file variable (README, owner tasks), so a build hashed the google-services.json it names while
// an update, which never sees the file, resolved a runtime version no build has and silently never
// applied (increment 9 re-review, expo-correctness-1). The file is therefore left out of the
// fingerprint on both sides. Nothing an update could break on depends on it: Firebase's Gradle
// plugin reads it at build time only, and a new Firebase project is a new build anyway. Every
// other fingerprinted variable stays Plain text or Sensitive (README, owner tasks), and
// __tests__/app-config.test.ts holds this file to the rule below.
//
// How: @expo/fingerprint records an external file by its path relative to the project root, and
// for an ignore pattern that starts with `**/` it strips the `../` prefixes a file outside the
// project carries before matching (build/utils/Path.js, isIgnoredPathWithMatchObjects). So the
// file each variable names is ignored by exactly that rule, plus the conventional names of a file
// kept in the project (they are gitignored). With no variable set, as under `eas update`, the
// list is the static entries alone, and nothing else about the fingerprint differs.
const path = require('path');

/** The variables app.config.ts turns into `android.googleServicesFile` (an iOS one would join). */
const GOOGLE_SERVICES_FILE_VARIABLES = ['GOOGLE_SERVICES_JSON'];

const CONVENTIONAL_NAMES = ['**/google-services*.json', '**/GoogleService-Info*.plist'];

function ignorePatternFor(projectRoot, file) {
  const relative = path.relative(projectRoot, path.resolve(projectRoot, file)).split(path.sep);
  return `**/${relative.join('/').replace(/^(\.\.\/)+/, '')}`;
}

/** The ignore entries for `env`: the conventional names, then each named file's own pattern. */
function googleServicesIgnorePaths(env, projectRoot = __dirname) {
  const named = GOOGLE_SERVICES_FILE_VARIABLES.map((name) => env[name])
    .filter((file) => typeof file === 'string' && file.trim() !== '')
    .map((file) => ignorePatternFor(projectRoot, file.trim()));
  return [...CONVENTIONAL_NAMES, ...named];
}

/** Hand-written native sources outside the plugins' own files, hashed as whole directories. */
const NATIVE_SOURCE_DIRS = [
  { dir: 'targets', reason: 'watchOS shells (@bacons/apple-targets): Swift, Info.plist, configs' },
  { dir: 'wear', reason: 'Wear OS module (plugins/withWearApp.ts): Kotlin, manifest, resources' },
];

/** What apple-targets generates inside targets/ on every prebuild (the watch app's icon). */
const GENERATED_TARGET_FILES = ['targets/*/Assets.xcassets/**/*'];

module.exports = {
  extraSources: NATIVE_SOURCE_DIRS.map(({ dir, reason }) => ({
    type: 'dir',
    filePath: dir,
    reasons: [reason],
  })),
  ignorePaths: [...GENERATED_TARGET_FILES, ...googleServicesIgnorePaths(process.env)],
  googleServicesIgnorePaths,
  GENERATED_TARGET_FILES,
};
