/**
 * The notification pre-prompt (increment 16, ruling C1; R2 design 2): shown after a flight add
 * succeeds, once per installation and only while the system prompt can still show
 * (src/lib/push.ts `takePushPromptOffer`), it says what the alerts are for before the system
 * prompt does. "Turn on notifications" asks for alert and sound only and registers the answer at
 * once; "Not now" leaves it to Settings. The copy is the owner's to confirm (R2 owner action 8).
 */

import * as Sentry from '@sentry/react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Screen, Title } from '../../components/ui';
import { requestPushPermission } from '../../lib/push';
import { pushRegistrar } from '../../lib/push-registration';

export default function NotificationsPrompt() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const turnOn = async () => {
    setBusy(true);
    try {
      await requestPushPermission();
      // The answer reaches the server now, not at the next foreground.
      void pushRegistrar().register();
    } catch (error) {
      Sentry.captureException(error);
    }
    router.back();
  };

  return (
    <Screen testID="notifications-prompt">
      <Title>Alerts for your flights</Title>
      <Body>
        PlaneAhead can tell you as soon as a flight you track is delayed, changes gate, is cancelled
        or is diverted.
      </Body>
      <Body muted>You can turn notifications off at any time in Settings.</Body>
      <Button
        testID="notifications-turn-on"
        title="Turn on notifications"
        busy={busy}
        onPress={() => {
          void turnOn();
        }}
      />
      <Button
        testID="notifications-not-now"
        title="Not now"
        variant="secondary"
        disabled={busy}
        onPress={() => {
          router.back();
        }}
      />
    </Screen>
  );
}
