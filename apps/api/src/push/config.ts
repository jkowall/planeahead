/**
 * The push transport's configuration, read from the Worker's secrets (increment 14, ruling P7).
 *
 * APNs is configured when `APNS_KEY_P8`, `APNS_KEY_ID` and `APNS_TEAM_ID` are all present and well
 * formed; FCM when `FCM_SERVICE_ACCOUNT_JSON` parses as a service account. They are required in
 * production and optional in staging and locally, so staging deploys before the Apple account
 * exists: an unconfigured platform's jobs are held as `not_configured` by the `push` consumer and
 * the admin page says which name is missing. A problem names the secret, never its value.
 *
 * The key is not imported here (that is `PushAuth`'s first mint): a PEM that parses but does not
 * import surfaces as `credentials_rejected` on the first send and on the admin page.
 */

import { z } from 'zod';
import type { Env } from '../env';
import { normalisePem } from '../auth/apple-client-secret';

/** Apple's key ids and team ids are ten upper-case letters or digits. */
export const APPLE_TEN_CHARACTER_ID_RE = /^[A-Z0-9]{10}$/;

export interface ApnsMaterial {
  readonly keyPem: string;
  readonly keyId: string;
  readonly teamId: string;
}

export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyId: string | null;
  readonly privateKeyPem: string;
}

export type Material<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

function isPkcs8Pem(value: string): boolean {
  const normalised = normalisePem(value);
  return (
    normalised.startsWith('-----BEGIN PRIVATE KEY-----') &&
    normalised.endsWith('-----END PRIVATE KEY-----')
  );
}

export function apnsMaterial(env: Env): Material<ApnsMaterial> {
  const problems: string[] = [];
  const keyPem = env.APNS_KEY_P8?.trim() ?? '';
  const keyId = env.APNS_KEY_ID?.trim() ?? '';
  const teamId = env.APNS_TEAM_ID?.trim() ?? '';
  if (keyPem === '') {
    problems.push('APNS_KEY_P8 is not set');
  } else if (!isPkcs8Pem(keyPem)) {
    problems.push('APNS_KEY_P8 is not a PKCS8 PEM');
  }
  if (keyId === '') {
    problems.push('APNS_KEY_ID is not set');
  } else if (!APPLE_TEN_CHARACTER_ID_RE.test(keyId)) {
    problems.push('APNS_KEY_ID is not a 10-character key id');
  }
  if (teamId === '') {
    problems.push('APNS_TEAM_ID is not set');
  } else if (!APPLE_TEN_CHARACTER_ID_RE.test(teamId)) {
    problems.push('APNS_TEAM_ID is not a 10-character team id');
  }
  return problems.length === 0
    ? { ok: true, value: { keyPem, keyId, teamId } }
    : { ok: false, problems };
}

const ServiceAccountSchema = z.looseObject({
  type: z.literal('service_account').optional(),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  client_email: z.string().min(3).max(320).includes('@'),
  private_key_id: z.string().min(1).max(200).optional(),
  private_key: z.string().min(1),
});

export function fcmServiceAccount(env: Env): Material<FcmServiceAccount> {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON?.trim() ?? '';
  if (raw === '') {
    return { ok: false, problems: ['FCM_SERVICE_ACCOUNT_JSON is not set'] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['FCM_SERVICE_ACCOUNT_JSON is not JSON'] };
  }
  const parsed = ServiceAccountSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))];
    return {
      ok: false,
      problems: [`FCM_SERVICE_ACCOUNT_JSON has no valid ${fields.join(', ')}`],
    };
  }
  if (!isPkcs8Pem(parsed.data.private_key)) {
    return { ok: false, problems: ['FCM_SERVICE_ACCOUNT_JSON private_key is not a PKCS8 PEM'] };
  }
  return {
    ok: true,
    value: {
      projectId: parsed.data.project_id,
      clientEmail: parsed.data.client_email,
      privateKeyId: parsed.data.private_key_id ?? null,
      privateKeyPem: parsed.data.private_key,
    },
  };
}

export interface PlatformConfiguration {
  readonly configured: boolean;
  /** What is missing or malformed, by secret name; empty when configured. */
  readonly problems: readonly string[];
}

export interface PushConfiguration {
  readonly apns: PlatformConfiguration;
  readonly fcm: PlatformConfiguration & { readonly projectId: string | null };
}

export function pushConfiguration(env: Env): PushConfiguration {
  const apns = apnsMaterial(env);
  const fcm = fcmServiceAccount(env);
  return {
    apns: apns.ok
      ? { configured: true, problems: [] }
      : { configured: false, problems: apns.problems },
    fcm: fcm.ok
      ? { configured: true, problems: [], projectId: fcm.value.projectId }
      : { configured: false, problems: fcm.problems, projectId: null },
  };
}
