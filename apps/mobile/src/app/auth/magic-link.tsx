/**
 * The universal link target: `https://api.planeahead.app/auth/magic-link?token=...` (and the
 * staging host) opens here, in whatever state the app is in.
 *
 * Verification happens IN THE APP, over the Better Auth client's own fetch with no
 * `callbackURL`: the anonymous session cookie rides along, so the server merges this phone's
 * anonymous account into the one the link signs in to, and the answer is JSON plus `Set-Cookie`
 * rather than a redirect carrying the cookie in its URL (increment 5; threat model 1.5).
 *
 * A link this install asked for in the last fifteen minutes is verified at once. Any other link
 * (forwarded, requested on another device, or old) waits for an explicit tap, because verifying
 * it signs this phone into whoever requested it.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Body, Button, Loading, Screen, Title } from '../../components/ui';
import { MAGIC_LINK_TOKEN_SHAPE, pendingMagicLink, verifyMagicLink } from '../../lib/magic-link';

type Phase = 'verifying' | 'confirm' | 'invalid' | 'failed';

export default function MagicLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const wellFormed = MAGIC_LINK_TOKEN_SHAPE.test(token);
  const [pending] = useState(() => pendingMagicLink());
  const [phase, setPhase] = useState<Phase>(
    !wellFormed ? 'invalid' : pending === null ? 'confirm' : 'verifying',
  );
  const started = useRef(false);

  const verify = useCallback(async () => {
    setPhase('verifying');
    const result = await verifyMagicLink(token).catch(() => ({
      ok: false as const,
      code: 'network',
    }));
    if (result.ok) {
      router.replace('/');
      return;
    }
    setPhase(result.code === 'network' ? 'failed' : 'invalid');
  }, [router, token]);

  useEffect(() => {
    if (phase === 'verifying' && !started.current) {
      started.current = true;
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
            This link was not requested from this phone. Only continue if you asked for it:
            continuing signs this phone in to the account the link was sent to.
          </Body>
          <Button
            testID="magic-link-confirm"
            title="Sign in"
            onPress={() => {
              started.current = true;
              void verify();
            }}
          />
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
