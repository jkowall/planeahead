/**
 * `aps-environment` from the build's signing, applied after every other plugin (increment 11,
 * ADR 0008; the slot was reserved in increment 9).
 *
 * Two writers touch the key, in this order: `ios.entitlements` in app.config.ts (merged in when
 * the entitlements file is READ, before any plugin's mod) and expo-widgets 57.0.20, whose
 * `withPushNotifications` sets the literal `development` unconditionally
 * (plugin/src/ios/withPushNotifications.ts). `expo-notifications` writes its `mode` prop only
 * where the key is absent (plugin/src/withNotificationsIOS.ts), which `ios.entitlements` never
 * leaves it, so it writes nothing (R2 conflict 9). Left alone, a production or ad hoc preview
 * build would register its Live Activity tokens with the sandbox APNs.
 *
 * Being the LAST entry in `plugins` is not enough on its own. A mod registered through
 * `withEntitlementsPlist` wraps the chain registered before it and runs its action FIRST, then
 * hands the result to the earlier plugins (`withMod` in @expo/config-plugins 57.0.9: `action`,
 * then `nextMod`); a plain `withEntitlementsPlist` here was measured to lose to expo-widgets
 * (`expo config --type introspect`, production profile: `development`). So this plugin
 * registers a base mod that runs the rest of the chain FIRST and writes its value on the way
 * back out, which is the last word whatever order the other plugins registered in. Listing it
 * last in app.config.ts still matters: a plugin listed after it would wrap it in turn.
 *
 * The value is `APNS_ENVIRONMENT` from the EAS profile (eas.json: `production` for the preview
 * and production profiles, `development` for development; ADR 0001 decision 2), passed in by
 * app.config.ts. __tests__/entitlements.test.ts evaluates the whole plugin chain per profile.
 */

import { withBaseMod, type ConfigPlugin } from 'expo/config-plugins';

export interface ApsEnvironmentProps {
  readonly apsEnvironment: 'development' | 'production';
}

export const withApsEnvironment: ConfigPlugin<ApsEnvironmentProps> = (config, props) =>
  withBaseMod<Record<string, unknown>>(config, {
    platform: 'ios',
    mod: 'entitlements',
    isProvider: false,
    async action({ modRequest: { nextMod, ...modRequest }, ...rest }) {
      if (nextMod === undefined) {
        throw new Error('withApsEnvironment: the entitlements mod chain has no next mod');
      }
      const results = await nextMod({ ...rest, modRequest });
      results.modResults['aps-environment'] = props.apsEnvironment;
      return results;
    },
  });

export default withApsEnvironment;
