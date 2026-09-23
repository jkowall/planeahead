/**
 * Reserved slot for the `aps-environment` fix (increment 9 stub; increment 11 implements it).
 *
 * `ios.entitlements` in app.config.ts is applied before every plugin, `expo-notifications` then
 * writes `aps-environment` from its `mode` option (set per variant), and in increment 11
 * expo-widgets' push-notification mod writes the literal `development` unconditionally
 * (docs/increments/09-11-mobile.facts.md section 5). A production Live Activity token would then be
 * minted against sandbox APNs. The fix is a plugin that runs LAST and writes the variant's value
 * back; this file reserves that position in the plugin list now, so increment 11 changes one
 * function body rather than the plugin order.
 *
 * Until then it changes nothing: every plugin before it already produces the right value.
 */

import type { ConfigPlugin } from 'expo/config-plugins';

export interface ApsEnvironmentProps {
  readonly apsEnvironment: 'development' | 'production';
}

export const withApsEnvironment: ConfigPlugin<ApsEnvironmentProps> = (config) => config;

export default withApsEnvironment;
