/**
 * Patterns that must never appear in a client bundle. Increment 9's CI job greps the
 * `expo export` output with these; the API talks to providers, the app only talks to the API.
 * Keep them broad: a false positive costs a look, a false negative ships a key.
 */
export const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  // Provider API hostnames and paths: the mobile bundle has no business knowing them. Bare
  // provider names are not listed because `PROVIDER_IDS` ships in the bundle and attribution
  // screens may name the providers.
  /aeroapi\.flightaware\.com/i,
  /flightaware\.com\/aeroapi/i,
  /aerodatabox\.p\.rapidapi\.com/i,
  /aedbx\/aerodatabox/i,
  /api\.market/i,
  /adsb\.lol/i,
  /adsb\.fi/i,
  /airplanes\.live/i,
  /aviationweather\.gov/i,
  /api\.weather\.gov/i,
  /open-meteo\.com/i,
  /nasstatus\.faa\.gov/i,
  // Environment variable and secret names. Written as prefix and suffix groups so that no
  // pattern matches its own source: this module ships inside the mobile bundle.
  /\bAERO[A-Z_]*(?:KEY|TOKEN|SECRET)\b/,
  /\bAPNS_[A-Z0-9_]+/,
  /\bFCM_[A-Z0-9_]+/,
  /\b(?:BETTER_AUTH|RESEND_API|GOOGLE_CLIENT|REVENUECAT_WEBHOOK)_(?:SECRET|KEY)\b/,
  /\bTOKEN_KEK_V\d+\b/,
  /\bAPPLE_SIWA_(?:P8|KEY_ID|TEAM_ID)\b/,
  // Key material shapes.
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/,
  /\bre_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
]);

/** Returns the patterns that match `text`, for a readable CI failure message. */
export function findSecretPatterns(text: string): RegExp[] {
  return SECRET_PATTERNS.filter((pattern) => pattern.test(text));
}
