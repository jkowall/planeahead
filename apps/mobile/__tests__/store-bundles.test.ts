/**
 * @jest-environment node
 *
 * plugins/withExtensionPrivacyManifests.ts and plugins/withExtensionVersions.ts (increment 13,
 * rulings S1 and S3, and review ruling F6: EAS's build number reaches every embedded target),
 * against generated projects: a real `expo prebuild --platform ios` of the
 * production variant in a temporary copy of the app (support/generated-ios-project.ts), with every
 * plugin app.config.ts lists, read back with the parser @bacons/apple-targets writes it with.
 *
 * The native smoke proves the rest on built products: every bundle's manifest covers the
 * required-reason symbols its executable references, and every bundle carries the app's version
 * (scripts/native-smoke.sh ios-archive and ios-device-archive).
 */

import {
  EXTENSION_PRIVACY_MANIFESTS,
  EXTENSION_TARGETS,
  addExtensionPrivacyManifests,
  privacyManifestPlist,
  type AppleProject,
} from '../plugins/withExtensionPrivacyManifests';
import {
  alignExtensionVersions,
  embeddedVersions,
  type VersionedProject,
} from '../plugins/withExtensionVersions';
import {
  openProject,
  prebuildIos,
  replaceInFile,
  type BaconsProject,
  type GeneratedProject,
  type XcodeModel,
} from './support/generated-ios-project';

const fs = jest.requireActual<{ rmSync(path: string, options: { recursive: true }): void }>('fs');
const path = jest.requireActual<{ join(...parts: string[]): string }>('path');

const APP_TARGET = 'PlaneAhead';
/** app.config.ts `version`, and the build number Expo writes when `ios.buildNumber` is unset. */
const APP_VERSION = '0.1.0';
const APP_BUILD_NUMBER = '1';

function nativeTarget(project: BaconsProject, name: string): XcodeModel {
  const target = project.rootObject.props.targets.find(
    (candidate) => candidate.isa === 'PBXNativeTarget' && candidate.props['name'] === name,
  );
  if (target === undefined) {
    throw new Error(`no ${name} target`);
  }
  return target;
}

/** The PrivacyInfo.xcprivacy file references in a target's Resources build phase. */
function manifestReferences(project: BaconsProject, name: string): XcodeModel[] {
  const phases = nativeTarget(project, name).props['buildPhases'] as XcodeModel[];
  const resources = phases.filter((phase) => phase.isa === 'PBXResourcesBuildPhase');
  return resources
    .flatMap((phase) => phase.props['files'] as XcodeModel[])
    .map((file) => file.props['fileRef'] as XcodeModel | undefined)
    .filter(
      (ref): ref is XcodeModel =>
        ref !== undefined && String(ref.props['path']).endsWith('PrivacyInfo.xcprivacy'),
    );
}

/** A file reference's path from the ios/ directory, through the group that holds it. */
function projectPath(project: BaconsProject, ref: XcodeModel): string {
  const group = [...project.values()].find(
    (object) =>
      object.isa === 'PBXGroup' && (object.props['children'] as XcodeModel[]).includes(ref),
  );
  const groupPath = group?.props['path'];
  const refPath = String(ref.props['path']);
  return typeof groupPath === 'string' ? `${groupPath}/${refPath}` : refPath;
}

function buildSettings(project: BaconsProject, name: string): Record<string, unknown>[] {
  const list = nativeTarget(project, name).props['buildConfigurationList'] as XcodeModel;
  return (list.props['buildConfigurations'] as XcodeModel[]).map(
    (configuration) => configuration.props['buildSettings'] as Record<string, unknown>,
  );
}

function objectCount(project: BaconsProject, isa: string): number {
  return [...project.values()].filter((object) => object.isa === isa).length;
}

describe('a generated production project', () => {
  let generated: GeneratedProject;

  beforeAll(() => {
    generated = prebuildIos();
    if (generated.status !== 0) {
      throw new Error(`expo prebuild failed:\n${generated.output}`);
    }
  }, 120_000);

  afterAll(() => {
    generated.remove();
  });

  it.each(EXTENSION_TARGETS)(
    'gives %s its own privacy manifest, in its own Resources build phase',
    (name) => {
      const project = openProject(generated);
      const references = manifestReferences(project, name);
      expect(references).toHaveLength(1);
      const [reference] = references as [XcodeModel];
      expect(projectPath(project, reference)).toBe(`${name}/PrivacyInfo.xcprivacy`);
      expect(reference.props['lastKnownFileType']).toBe('text.xml');
      expect(generated.readFile(`ios/${name}/PrivacyInfo.xcprivacy`)).toBe(
        privacyManifestPlist(EXTENSION_PRIVACY_MANIFESTS[name]),
      );
    },
  );

  it("leaves the app the manifest Expo writes from app.config.ts, and no bundle another's", () => {
    const project = openProject(generated);
    const paths = [APP_TARGET, ...EXTENSION_TARGETS].map((name) => {
      const references = manifestReferences(project, name);
      expect(references).toHaveLength(1);
      return projectPath(project, references[0] as XcodeModel);
    });
    expect(paths[0]).toBe('PlaneAhead/PrivacyInfo.xcprivacy');
    expect(new Set(paths).size).toBe(paths.length);
    // Expo's manifest carries the app's declarations (the collected data among them).
    expect(generated.readFile('ios/PlaneAhead/PrivacyInfo.xcprivacy')).toContain(
      'NSPrivacyCollectedDataTypeEmailAddress',
    );
  });

  it('declares the App Group defaults in the widget extension and nothing in the watch shells', () => {
    expect(EXTENSION_PRIVACY_MANIFESTS).toEqual({
      ExpoWidgetsTarget: [
        { category: 'NSPrivacyAccessedAPICategoryUserDefaults', reasons: ['1C8F.1'] },
      ],
      PlaneAheadWatch: [],
      PlaneAheadWatchWidget: [],
    });
    expect(generated.readFile('ios/ExpoWidgetsTarget/PrivacyInfo.xcprivacy')).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '\t<key>NSPrivacyAccessedAPITypes</key>',
        '\t<array>',
        '\t\t<dict>',
        '\t\t\t<key>NSPrivacyAccessedAPIType</key>',
        '\t\t\t<string>NSPrivacyAccessedAPICategoryUserDefaults</string>',
        '\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>',
        '\t\t\t<array>',
        '\t\t\t\t<string>1C8F.1</string>',
        '\t\t\t</array>',
        '\t\t</dict>',
        '\t</array>',
        '\t<key>NSPrivacyCollectedDataTypes</key>',
        '\t<array/>',
        '\t<key>NSPrivacyTracking</key>',
        '\t<false/>',
        '\t<key>NSPrivacyTrackingDomains</key>',
        '\t<array/>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
    for (const name of ['PlaneAheadWatch', 'PlaneAheadWatchWidget']) {
      const manifest = generated.readFile(`ios/${name}/PrivacyInfo.xcprivacy`);
      expect(manifest).toContain('\t<key>NSPrivacyAccessedAPITypes</key>\n\t<array/>\n');
      expect(manifest).toContain('\t<key>NSPrivacyTracking</key>\n\t<false/>\n');
      expect(manifest).not.toContain('NSPrivacyAccessedAPICategory');
    }
  });

  it("gives every embedded target the app's version and build number, in every configuration", () => {
    const project = openProject(generated);
    for (const settings of buildSettings(project, APP_TARGET)) {
      expect(String(settings['MARKETING_VERSION'])).toBe(APP_VERSION);
      expect(String(settings['CURRENT_PROJECT_VERSION'])).toBe(APP_BUILD_NUMBER);
    }
    for (const name of EXTENSION_TARGETS) {
      const configurations = buildSettings(project, name);
      expect(configurations).toHaveLength(2);
      for (const settings of configurations) {
        expect(String(settings['MARKETING_VERSION'])).toBe(APP_VERSION);
        expect(String(settings['CURRENT_PROJECT_VERSION'])).toBe(APP_BUILD_NUMBER);
      }
    }
    // What expo-widgets writes into its own Info.plist from the same config.
    const widgetInfo = generated.readFile('ios/ExpoWidgetsTarget/Info.plist');
    expect(widgetInfo).toMatch(
      /<key>CFBundleShortVersionString<\/key>\s*<string>0\.1\.0<\/string>/,
    );
    expect(widgetInfo).toMatch(/<key>CFBundleVersion<\/key>\s*<string>1<\/string>/);
  });

  it('adds nothing when it runs again on its own output', () => {
    const project = openProject(generated);
    const before = ['PBXBuildFile', 'PBXFileReference', 'PBXGroup'].map((isa) =>
      objectCount(project, isa),
    );
    const files = addExtensionPrivacyManifests(project as unknown as AppleProject);
    expect(files).toEqual(
      EXTENSION_TARGETS.map((name) => ({
        path: `${name}/PrivacyInfo.xcprivacy`,
        contents: privacyManifestPlist(EXTENSION_PRIVACY_MANIFESTS[name]),
      })),
    );
    expect(
      ['PBXBuildFile', 'PBXFileReference', 'PBXGroup'].map((isa) => objectCount(project, isa)),
    ).toEqual(before);
  });

  it('refuses a project without a target it expects, before changing any', () => {
    const project = openProject(generated);
    nativeTarget(project, 'ExpoWidgetsTarget').removeFromProject?.();
    const buildFiles = objectCount(project, 'PBXBuildFile');
    expect(() => addExtensionPrivacyManifests(project as unknown as AppleProject)).toThrow(
      /no ExpoWidgetsTarget target in the Xcode project/,
    );
    expect(objectCount(project, 'PBXBuildFile')).toBe(buildFiles);
  });

  it("realigns targets whose versions drifted and leaves the app's alone", () => {
    const project = openProject(generated);
    const [watchDebug, watchRelease] = buildSettings(project, 'PlaneAheadWatch') as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // What apple-targets' configuration list writes before its own sync, and a stray build number.
    watchRelease['MARKETING_VERSION'] = '1.0';
    watchDebug['CURRENT_PROJECT_VERSION'] = '7';
    const [appDebug] = buildSettings(project, APP_TARGET) as [Record<string, unknown>];
    appDebug['MARKETING_VERSION'] = '9.9';

    const aligned = alignExtensionVersions(project as unknown as VersionedProject, {
      appTarget: APP_TARGET,
      version: APP_VERSION,
      buildNumber: APP_BUILD_NUMBER,
    });

    expect(aligned.sort()).toEqual([...EXTENSION_TARGETS].sort());
    for (const name of EXTENSION_TARGETS) {
      for (const settings of buildSettings(project, name)) {
        expect(settings['MARKETING_VERSION']).toBe(APP_VERSION);
        expect(settings['CURRENT_PROJECT_VERSION']).toBe(APP_BUILD_NUMBER);
      }
    }
    expect(appDebug['MARKETING_VERSION']).toBe('9.9');
  });
});

describe('generated projects with a change planted', () => {
  const projects: GeneratedProject[] = [];

  afterAll(() => {
    for (const project of projects) {
      project.remove();
    }
  });

  function prebuild(edit: (root: string) => void, env?: Record<string, string>): GeneratedProject {
    const project = prebuildIos(edit, env);
    projects.push(project);
    return project;
  }

  it('fails the prebuild when a target it expects is missing', () => {
    const project = prebuild((root) => {
      fs.rmSync(path.join(root, 'targets', 'watch-widget'), { recursive: true });
    });
    expect(project.status).not.toBe(0);
    expect(project.output).toContain(
      'withExtensionPrivacyManifests: no PlaneAheadWatchWidget target in the Xcode project',
    );
  }, 60_000);

  it("fails the prebuild when @bacons/apple-targets' project mod never runs", () => {
    const project = prebuild((root) => {
      replaceInFile(root, 'app.config.ts', "      '@bacons/apple-targets',\n", '');
    });
    expect(project.status).not.toBe(0);
    expect(project.output).toMatch(
      /withExtension(PrivacyManifests|Versions): @bacons\/apple-targets' xcodeProjectBeta2 mod never ran/,
    );
  }, 60_000);

  it("gives every embedded target the build number EAS exports, never the app's config", () => {
    // EAS exports EAS_BUILD_IOS_BUILD_NUMBER to the whole build, prebuild included; its rewrite
    // of each target's Info.plist loses to these build settings (review ruling F6).
    const project = prebuild(() => undefined, { EAS_BUILD_IOS_BUILD_NUMBER: '7' });
    expect(project.status).toBe(0);
    const parsed = openProject(project);
    const embedded = EXTENSION_TARGETS.flatMap((name) => buildSettings(parsed, name));
    expect(embedded).toHaveLength(6);
    for (const settings of embedded) {
      expect(String(settings['CURRENT_PROJECT_VERSION'])).toBe('7');
      expect(String(settings['MARKETING_VERSION'])).toBe(APP_VERSION);
    }
    // The app target's own settings and the config are the config's: nothing fingerprinted moved.
    for (const settings of buildSettings(parsed, APP_TARGET)) {
      expect(String(settings['CURRENT_PROJECT_VERSION'])).toBe(APP_BUILD_NUMBER);
    }
  }, 60_000);

  it('refuses to be listed after @bacons/apple-targets, whose provider is then in place', () => {
    const plugins =
      "      './plugins/withExtensionPrivacyManifests.ts',\n      './plugins/withExtensionVersions.ts',\n";
    const project = prebuild((root) => {
      replaceInFile(root, 'app.config.ts', plugins, '');
      replaceInFile(
        root,
        'app.config.ts',
        "      '@bacons/apple-targets',\n",
        `      '@bacons/apple-targets',\n${plugins}`,
      );
    });
    expect(project.status).not.toBe(0);
    expect(project.output).toContain(
      'Cannot add mod to "ios.xcodeProjectBeta2" because the provider has already been added',
    );
    expect(project.exists('ios/PlaneAheadWatch/PrivacyInfo.xcprivacy')).toBe(false);
  }, 60_000);
});

describe('embeddedVersions', () => {
  const config = { version: APP_VERSION, buildNumber: APP_BUILD_NUMBER };

  it("takes EAS's version and build number when the build exports them", () => {
    expect(
      embeddedVersions(config, {
        EAS_BUILD_IOS_APP_VERSION: '0.2.0',
        EAS_BUILD_IOS_BUILD_NUMBER: '42',
      }),
    ).toEqual({ version: '0.2.0', buildNumber: '42' });
    expect(embeddedVersions(config, { EAS_BUILD_IOS_BUILD_NUMBER: '1.0.3' })).toEqual({
      version: APP_VERSION,
      buildNumber: '1.0.3',
    });
  });

  it("keeps the config's without them, an empty variable counting as none", () => {
    expect(embeddedVersions(config, {})).toEqual(config);
    expect(
      embeddedVersions(config, { EAS_BUILD_IOS_APP_VERSION: '', EAS_BUILD_IOS_BUILD_NUMBER: ' ' }),
    ).toEqual(config);
  });

  it('refuses a value Apple would refuse', () => {
    for (const value of ['7a', '1.2.3.4', '-1', '1..2']) {
      expect(() => embeddedVersions(config, { EAS_BUILD_IOS_BUILD_NUMBER: value })).toThrow(
        /EAS_BUILD_IOS_BUILD_NUMBER must be one to three period-separated integers/,
      );
    }
    expect(() => embeddedVersions(config, { EAS_BUILD_IOS_APP_VERSION: 'v1' })).toThrow(
      /EAS_BUILD_IOS_APP_VERSION/,
    );
  });
});

describe('alignExtensionVersions', () => {
  const target = (
    name: string,
    configurations: number,
  ): VersionedProject['rootObject']['props']['targets'][number] => ({
    isa: 'PBXNativeTarget',
    props: {
      name,
      buildConfigurationList: {
        props: {
          buildConfigurations: Array.from({ length: configurations }, () => ({
            props: { buildSettings: {} },
          })),
        },
      },
    },
  });
  const versions = { appTarget: APP_TARGET, version: APP_VERSION, buildNumber: APP_BUILD_NUMBER };

  it('refuses a project without the app target, or a target without a configuration', () => {
    expect(() =>
      alignExtensionVersions(
        { rootObject: { props: { targets: [target('Other', 2)] } } },
        versions,
      ),
    ).toThrow(/no PlaneAhead app target/);
    expect(() =>
      alignExtensionVersions(
        { rootObject: { props: { targets: [target(APP_TARGET, 2), target('Other', 0)] } } },
        versions,
      ),
    ).toThrow(/Other has no build configuration/);
  });
});
