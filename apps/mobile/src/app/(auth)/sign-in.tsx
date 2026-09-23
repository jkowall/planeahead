/**
 * Sign in, or upgrade an anonymous account: native Apple (iOS), native Google, a magic link, or
 * carry on without an account. Every path posts to the increment 5 endpoints with the anonymous
 * session cookie attached, so the flights added on this phone move to the account.
 */

import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, TextInput } from 'react-native';
import { Body, Button, Screen, Section, Title, usePalette } from '../../components/ui';
import { authClient, isAnonymousSession } from '../../lib/auth-client';
import { runtimeConfig } from '../../lib/config';
import { requestMagicLink } from '../../lib/magic-link';
import { signInWithApple } from '../../lib/native-signin/apple';
import { signInWithGoogle } from '../../lib/native-signin/google';
import type { NativeSignInResult } from '../../lib/native-signin/nonce';
import { useTheme } from '../../theme/useTheme';

type Busy = 'apple' | 'google' | 'email' | 'anonymous' | null;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInScreen() {
  const router = useRouter();
  const palette = usePalette();
  const { scheme } = useTheme();
  const { data: session } = authClient.useSession();
  const anonymous = isAnonymousSession(session);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const googleConfigured = runtimeConfig().googleWebClientId !== null;

  const run = async (which: Exclude<Busy, null>, action: () => Promise<NativeSignInResult>) => {
    setBusy(which);
    setMessage(null);
    try {
      const result = await action();
      if (result.status === 'signed_in') {
        router.replace('/');
      }
    } catch {
      setMessage('Sign-in did not complete. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  const sendLink = async () => {
    if (!EMAIL_SHAPE.test(email.trim())) {
      setMessage('Enter the email address to send the link to.');
      return;
    }
    setBusy('email');
    setMessage(null);
    const result = await requestMagicLink(email).catch(() => ({
      ok: false as const,
      code: 'network',
    }));
    setBusy(null);
    setMessage(
      result.ok
        ? `If ${email.trim()} can sign in, a link is on its way. Open it on this phone.`
        : 'The link could not be sent. Check your connection and try again.',
    );
  };

  const continueAnonymously = () =>
    run('anonymous', async () => {
      const { error } = await authClient.signIn.anonymous();
      if (error) {
        throw new Error('anonymous sign-in failed');
      }
      return { status: 'signed_in' };
    });

  return (
    <Screen testID="sign-in-screen">
      <Title>{anonymous ? 'Keep your flights' : 'Sign in to PlaneAhead'}</Title>
      <Body muted>
        {anonymous
          ? 'Sign in or create an account and the flights on this phone move to it.'
          : 'Track your flights on every device you sign in to.'}
      </Body>

      {Platform.OS === 'ios' ? (
        <AppleAuthenticationButton
          testID="sign-in-apple"
          buttonType={AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={
            scheme === 'dark'
              ? AppleAuthenticationButtonStyle.WHITE
              : AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={10}
          style={styles.apple}
          onPress={() => {
            void run('apple', signInWithApple);
          }}
        />
      ) : null}

      {googleConfigured ? (
        <Button
          testID="sign-in-google"
          title="Continue with Google"
          variant="secondary"
          busy={busy === 'google'}
          disabled={busy !== null}
          onPress={() => {
            void run('google', signInWithGoogle);
          }}
        />
      ) : null}

      <Section title="Email">
        <TextInput
          testID="sign-in-email"
          accessibilityLabel="Email address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          inputMode="email"
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor={palette.muted}
          value={email}
          onChangeText={setEmail}
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
        />
        <Button
          testID="sign-in-email-send"
          title="Email me a sign-in link"
          busy={busy === 'email'}
          disabled={busy !== null}
          onPress={() => {
            void sendLink();
          }}
        />
      </Section>

      {session === null ? (
        <Button
          testID="sign-in-anonymous"
          title="Continue without an account"
          variant="secondary"
          busy={busy === 'anonymous'}
          disabled={busy !== null}
          onPress={() => {
            void continueAnonymously();
          }}
        />
      ) : (
        <Button
          testID="sign-in-not-now"
          title="Not now"
          variant="secondary"
          onPress={() => {
            router.replace('/');
          }}
        />
      )}

      {message === null ? null : <Body testID="sign-in-message">{message}</Body>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  apple: { height: 48 },
  input: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
});
