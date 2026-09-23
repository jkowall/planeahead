/**
 * The app's primitives, on the theme tokens (src/theme). Increment 9 carried its own palette
 * here; increment 10 moved every colour, space and type size into `src/theme/tokens.ts`, and
 * `usePalette()` stays only as a narrow view of the tokens for the increment 9 sign-in screen.
 */

import type { ReactElement, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/useTheme';

export interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly accentText: string;
  readonly danger: string;
  readonly border: string;
}

/** The increment 9 palette shape, read from the theme tokens. */
export function usePalette(): Palette {
  const { color } = useTheme();
  return {
    background: color.background,
    surface: color.surface,
    text: color.text,
    muted: color.textMuted,
    accent: color.accent,
    accentText: color.accentText,
    danger: color.danger,
    border: color.border,
  };
}

export function Screen({
  children,
  testID,
  refreshControl,
}: {
  children: ReactNode;
  testID?: string;
  refreshControl?: ReactElement<RefreshControlProps>;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.color.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.screen,
          { padding: theme.space.xl - 4, gap: theme.space.lg },
        ]}
        testID={testID}
        {...(refreshControl === undefined ? {} : { refreshControl })}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={[styles.title, { color: theme.color.text, fontSize: theme.font.title }]}
    >
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted = false,
  testID,
}: {
  children: ReactNode;
  muted?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Text
      testID={testID}
      style={[
        styles.body,
        {
          color: muted ? theme.color.textMuted : theme.color.text,
          fontSize: theme.font.body,
        },
      ]}
    >
      {children}
    </Text>
  );
}

export function Section({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.section,
        {
          backgroundColor: theme.color.surface,
          borderColor: theme.color.border,
          borderRadius: theme.radius.lg - 2,
          padding: theme.space.lg,
          gap: theme.space.md,
        },
      ]}
    >
      <Text
        style={[styles.sectionTitle, { color: theme.color.textMuted, fontSize: theme.font.small }]}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

export interface ButtonProps {
  readonly title: string;
  readonly onPress: () => void;
  readonly testID?: string;
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly selected?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityHint?: string;
}

export function Button({
  title,
  onPress,
  testID,
  variant = 'primary',
  disabled = false,
  busy = false,
  selected,
  style,
  accessibilityHint,
}: ButtonProps) {
  const { color, radius, font } = useTheme();
  const background =
    variant === 'primary' ? color.accent : variant === 'danger' ? 'transparent' : color.surface;
  const foreground =
    variant === 'primary' ? color.accentText : variant === 'danger' ? color.danger : color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        disabled: disabled || busy,
        ...(selected === undefined ? {} : { selected }),
      }}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      disabled={disabled || busy}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: selected === true ? color.accent : color.border,
          borderWidth: selected === true ? 2 : StyleSheet.hairlineWidth,
          borderRadius: radius.md,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text style={[styles.buttonText, { color: foreground, fontSize: font.body }]}>{title}</Text>
      )}
    </Pressable>
  );
}

/** A labelled text input with its validation message underneath. */
export function TextField({
  label,
  error,
  testID,
  ...input
}: Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  label: string;
  error?: string | null | undefined;
  testID?: string;
}) {
  const { color, radius, space, font } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ color: color.textMuted, fontSize: font.small, fontWeight: '600' }}>
        {label}
      </Text>
      <TextInput
        {...input}
        testID={testID}
        accessibilityLabel={label}
        placeholderTextColor={color.textMuted}
        style={[
          styles.input,
          {
            color: color.text,
            backgroundColor: color.surfaceRaised,
            borderColor: error === null || error === undefined ? color.border : color.danger,
            borderRadius: radius.md,
            fontSize: font.body + 2,
          },
        ]}
      />
      {error === null || error === undefined ? null : (
        <Text
          testID={testID === undefined ? undefined : `${testID}-error`}
          accessibilityLiveRegion="polite"
          style={{ color: color.danger, fontSize: font.small }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

/** A dismissible message strip: a refused add, a refresh still running. */
export function Notice({
  children,
  tone = 'info',
  testID,
  onDismiss,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'danger';
  testID?: string;
  onDismiss?: () => void;
}) {
  const { color, radius, space, font } = useTheme();
  const accent =
    tone === 'danger' ? color.danger : tone === 'warning' ? color.warning : color.accent;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[
        styles.notice,
        {
          backgroundColor: color.surface,
          borderColor: accent,
          borderRadius: radius.md,
          padding: space.md,
          gap: space.sm,
        },
      ]}
    >
      <Text style={{ color: color.text, fontSize: font.body - 1, flex: 1 }}>{children}</Text>
      {onDismiss === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          testID={testID === undefined ? undefined : `${testID}-dismiss`}
          onPress={onDismiss}
          hitSlop={8}
        >
          <Text style={{ color: accent, fontSize: font.body - 1, fontWeight: '600' }}>OK</Text>
        </Pressable>
      )}
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  const { color } = useTheme();
  return (
    <View
      accessibilityLabel={label}
      style={[styles.fill, styles.center, { backgroundColor: color.background }]}
    >
      <ActivityIndicator color={color.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  screen: { padding: 20, gap: 16 },
  title: { fontWeight: '700' },
  body: { lineHeight: 22 },
  section: { borderWidth: StyleSheet.hairlineWidth },
  sectionTitle: { fontWeight: '600', textTransform: 'uppercase' },
  button: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  notice: {
    borderLeftWidth: 4,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
});
