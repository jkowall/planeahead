/**
 * plugins/withWearApp.ts (increment 11, ruling V6, ADR 0008): the Wear OS module it adds to the
 * Gradle build. The build itself is proven by `gradle assembleDebug` (the nightly and ADR 0008);
 * this pins what the plugin writes: the module included once, the phone app's package as the
 * watch app's, and every library at an exact version.
 */

import {
  WEAR_DEPENDENCIES,
  WEAR_MIN_SDK,
  includeWearProject,
  wearBuildGradle,
} from '../plugins/withWearApp';

const SETTINGS = "rootProject.name = 'PlaneAhead'\n\ninclude ':app'\n";

describe('withWearApp', () => {
  it('includes the Wear module in settings.gradle once, however often prebuild runs', () => {
    const once = includeWearProject(SETTINGS);
    expect(once).toContain("include ':app'");
    expect(once.match(/^include ':wear'$/gm)).toHaveLength(1);
    expect(includeWearProject(once)).toBe(once);
  });

  it('generates an application module that shares the phone app package and builds Compose', () => {
    const gradle = wearBuildGradle({
      applicationId: 'app.planeahead.mobile',
      versionName: '0.1.0',
    });
    expect(gradle).toContain("apply plugin: 'com.android.application'");
    expect(gradle).toContain("apply plugin: 'org.jetbrains.kotlin.plugin.compose'");
    expect(gradle).toContain("applicationId 'app.planeahead.mobile'");
    expect(gradle).toContain(`minSdk ${String(WEAR_MIN_SDK)}`);
    expect(gradle).toContain('compileSdk rootProject.ext.compileSdkVersion');
    // The sources stay in the repository, outside the generated android/ directory.
    expect(gradle).toContain("new File(rootProject.projectDir, '../wear/src/main')");
    for (const [artefact, version] of Object.entries(WEAR_DEPENDENCIES)) {
      expect(gradle).toContain(`implementation '${artefact}:${version}'`);
    }
  });

  it('pins every Wear library exactly, on lines this toolchain can build', () => {
    for (const version of Object.values(WEAR_DEPENDENCIES)) {
      expect(version).toMatch(/^\d+\.\d+(\.\d+)?$/);
    }
    // Wear Compose 1.7 needs compileSdk 37 and AGP 9.1; Expo SDK 57 builds with 36 and 8.12.
    expect(WEAR_DEPENDENCIES['androidx.wear.compose:compose-material3']).toMatch(/^1\.6\./);
    expect(WEAR_DEPENDENCIES['androidx.wear.tiles:tiles']).toBe('1.6.2');
  });
});
