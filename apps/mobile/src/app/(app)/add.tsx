/**
 * The add-flight sheet (increment 10, ruling T2): a flight number and a departure date, validated
 * with the shared `parseDesignator` and `IsoDateSchema` (the API's own rules), then written
 * through the outbox by `addFlight` (the optimistic row and the queued `POST /v1/flights` in one
 * transaction). The sheet waits for the drain so a refusal can be said in place: the free-tier
 * explanation from the payload's cap and limit on 403, the dates the search tried on 404. Offline,
 * the flight stays queued and the sheet closes; the list shows it as being added. The sheet can
 * be closed at any time: the add carries on, and a later refusal appears on the home screen.
 *
 * The date field keeps the number pad (iOS's has no hyphen key): the field inserts the hyphens of
 * `YYYY-MM-DD` as the digits are typed (`formatDateInput`), and the validation reads eight bare
 * digits as a date too (`normaliseDateInput`), so any date can be typed, not only the three chips
 * (increment 10 review).
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Body, Button, Notice, Screen, TextField, Title } from '../../components/ui';
import { useFlightNotices } from '../../lib/flight-notices';
import { addFlight, drainFor, validateAddFlight, type AddFlightErrors } from '../../lib/flights';
import { addDays, formatDateInput, formatIsoDate, localDate } from '../../lib/format';
import { services } from '../../lib/services';
import { useTheme } from '../../theme/useTheme';

type Phase = 'editing' | 'adding';

interface Message {
  readonly text: string;
  readonly tone: 'info' | 'danger';
}

export default function AddFlightSheet() {
  const router = useRouter();
  const theme = useTheme();
  const [today] = useState(() => localDate(Date.now()));
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(today);
  const [errors, setErrors] = useState<AddFlightErrors>({});
  const [phase, setPhase] = useState<Phase>('editing');
  const [message, setMessage] = useState<Message | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const quickDates = [0, 1, 2].map((offset) => addDays(today, offset));
  const clearError = (field: keyof AddFlightErrors) => {
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const submit = async () => {
    const validation = validateAddFlight({ number, date });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setMessage(null);
    setPhase('adding');
    try {
      const { store, outbox } = await services();
      const added = addFlight(store.sqlite, validation.value);
      if (added.kind === 'already_tracked') {
        if (mounted.current) {
          setPhase('editing');
          setMessage({
            tone: 'info',
            text: `You already track ${validation.value.designator} on ${formatIsoDate(validation.value.date)}.`,
          });
        }
        return;
      }
      await drainFor(outbox, store.sqlite, added.outboxId);
      const refused = useFlightNotices.getState().take(added.subscriptionId);
      if (!mounted.current) {
        if (refused !== null) {
          // Closed while adding: the home screen says it instead.
          useFlightNotices.getState().push(refused);
        }
        return;
      }
      if (refused !== null) {
        setPhase('editing');
        setMessage({ tone: 'danger', text: refused.message });
        return;
      }
      // Added, or queued until the phone is back online: either way the list shows it now.
      router.back();
    } catch {
      if (mounted.current) {
        setPhase('editing');
        setMessage({
          tone: 'danger',
          text: 'The flight could not be saved on this phone. Try again.',
        });
      }
    }
  };

  return (
    <Screen testID="add-flight-sheet">
      <Title>Add a flight</Title>
      <Body muted>The flight number and the date it departs, in the departure airport's time.</Body>

      <TextField
        testID="add-flight-number"
        label="Flight number"
        placeholder="AA100"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="next"
        value={number}
        onChangeText={(value) => {
          setNumber(value);
          clearError('number');
        }}
        error={errors.number}
        editable={phase === 'editing'}
      />

      <TextField
        testID="add-flight-date"
        label="Departure date"
        placeholder="YYYY-MM-DD"
        autoCorrect={false}
        autoComplete="off"
        inputMode="numeric"
        maxLength={10}
        value={date}
        onChangeText={(value) => {
          setDate(formatDateInput(value));
          clearError('date');
        }}
        error={errors.date}
        editable={phase === 'editing'}
      />
      <View style={[styles.chips, { gap: theme.space.sm }]}>
        {quickDates.map((value, index) => (
          <Button
            key={value}
            testID={`add-flight-date-${String(index)}`}
            title={index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : formatIsoDate(value)}
            variant="secondary"
            selected={date === value}
            disabled={phase !== 'editing'}
            style={styles.chip}
            onPress={() => {
              setDate(value);
              clearError('date');
            }}
          />
        ))}
      </View>

      {message === null ? null : (
        <Notice tone={message.tone} testID="add-flight-message">
          {message.text}
        </Notice>
      )}

      <Button
        testID="add-flight-submit"
        title="Add flight"
        busy={phase === 'adding'}
        onPress={() => {
          void submit();
        }}
      />
      <Button
        testID="add-flight-close"
        title={phase === 'adding' ? 'Close (it keeps adding)' : 'Cancel'}
        variant="secondary"
        onPress={() => {
          router.back();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { flexGrow: 1 },
});
