/**
 * The universal link target: `https://<api host>/auth/magic-link?token=...` opens here, in
 * whatever state the app is in.
 *
 * Verification happens IN THE APP, over the Better Auth client's own fetch with no
 * `callbackURL`: the anonymous session cookie rides along, so the server merges this phone's
 * anonymous account into the one the link signs in to, and the answer is JSON plus `Set-Cookie`
 * rather than a redirect carrying the cookie in its URL (increment 5; threat model 1.5).
 *
 * Verified at once only when this install asked for a link in the last fifteen minutes AND the
 * link arrived as a universal link on the host this build claims (src/lib/magic-link.ts). Any
 * other link (the `planeahead://` scheme, which any app can open, a link forwarded or requested on
 * another device, an old one) waits for an explicit tap, because verifying it signs this phone
 * into whoever requested it. A link that signs in to an address this install did not request is
 * undone (signed out, the anonymous session restored) and says so.
 *
 * How the link arrived is read from the router's own record of every delivered URL
 * (src/lib/delivered-url.ts, written by src/app/+native-intent.tsx), never from
 * `Linking.getLinkingURL()`, which on iOS stays at the first URL the process received. The phase
 * is decided from the token on screen and the last delivery, and decided again when a later
 * delivery arrives (a second link, or the same link tapped again after a failure); one verify
 * runs at a time.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Body, Button, Loading, Screen, Title } from '../../components/ui';
import { runtimeConfig } from '../../lib/config';
import { useDeliveredUrl, type DeliveredUrl } from '../../lib/delivered-url';
import {
  ACCOUNT_MISMATCH,
  MAGIC_LINK_TOKEN_SHAPE,
  magicLinkDelivery,
  pendingMagicLinks,
  verifyMagicLink,
} from '../../lib/magic-link';

type Phase = 'verifying' | 'confirm' | 'invalid' | 'failed' | 'mismatch';

/** Verify without asking, or ask first (the file header). */
function decidePhase(token: string, delivered: DeliveredUrl | null): Phase {
  if (!MAGIC_LINK_TOKEN_SHAPE.test(token)) {
    return 'invalid';
  }
  const requested = pendingMagicLinks().length > 0;
  const delivery = magicLinkDelivery(
    delivered?.url ?? null,
    token,
    runtimeConfig().universalLinkHosts,
  );
  return requested && delivery === 'universal_link' ? 'verifying' : 'confirm';
}

/** What a decision was made for: the token on screen and one delivery (its time included). */
function decisionKey(token: string, delivered: DeliveredUrl | null): string {
  return delivered === null ? token : `${token}\n${String(delivered.at)}\n${delivered.url}`;
}

export default function MagicLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const delivered = useDeliveredUrl();
  const token = typeof params.token === 'string' ? params.token : '';
  const [phase, setPhase] = useState<Phase>(() => decidePhase(token, delivered));
  const decidedFor = useRef(decisionKey(token, delivered));
  const inFlight = useRef<string | null>(null);

  const verify = useCallback(async () => {
    if (inFlight.current !== null) {
      return;
    }
    inFlight.current = token;
    setPhase('verifying');
    try {
      const result = await verifyMagicLink(token).catch(() => ({
        ok: false as const,
        code: 'network',
      }));
      if (result.ok) {
        router.replace('/');
        return;
      }
      setPhase(
        result.code === 'network'
          ? 'failed'
          : result.code === ACCOUNT_MISMATCH
            ? 'mismatch'
            : 'invalid',
      );
    } finally {
      inFlight.current = null;
    }
  }, [router, token]);

  // A later delivery, or a new token, is decided afresh; the first render decided the initial one.
  useEffect(() => {
    const key = decisionKey(token, delivered);
    if (decidedFor.current !== key) {
      decidedFor.current = key;
      setPhase(decidePhase(token, delivered));
    }
  }, [token, delivered]);

  useEffect(() => {
    if (phase === 'verifying') {
      void verify();
    }
  }, [phase, verify]);

  if (phase === 'verifying') {
    return <Loading label="Signing in" />;
  }

  return (
    <Screen testID="magic-link-screen">
      {phase === 'confirm' ? (
        <>
          <Title>Sign in with this link?</Title>
          <Body>
            This link was not opened from a sign-in email requested on this phone. Only continue if
            you asked for it: continuing signs this phone in to the account the link was sent to.
          </Body>
          <Button
            testID="magic-link-confirm"
            title="Sign in"
            onPress={() => {
              void verify();
            }}
          />
        </>
      ) : phase === 'mismatch' ? (
        <>
          <Title>That link was for another address</Title>
          <Body testID="magic-link-mismatch">
            It signed in to a different address than the one you asked for on this phone, so
            PlaneAhead signed out of it and kept you as you were. Open the link sent to the address
            you entered.
          </Body>
        </>
      ) : phase === 'failed' ? (
        <>
          <Title>You are offline</Title>
          <Body>Connect to the internet and open the link again.</Body>
        </>
      ) : (
        <>
          <Title>This link does not work</Title>
          <Body>It is invalid, expired or already used. Request a new one from the app.</Body>
        </>
      )}
      <Button
        testID="magic-link-cancel"
        title="Back to PlaneAhead"
        variant="secondary"
        onPress={() => {
          router.replace('/');
        }}
      />
    </Screen>
  );
}
