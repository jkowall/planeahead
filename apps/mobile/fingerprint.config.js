// CommonJS: @expo/fingerprint loads this file with require(), in every process that resolves the
// fingerprint runtime version: the EAS builder, `eas update` (through `expo-updates
// runtimeversion:resolve`) and a local `pnpm exec expo-updates runtimeversion:resolve`.
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

module.exports = {
  ignorePaths: googleServicesIgnorePaths(process.env),
  googleServicesIgnorePaths,
};
