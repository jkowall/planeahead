/**
 * The few primitives the increment 9 screens need. Increment 10 replaces the palette with theme
 * tokens (src/theme); nothing here is meant to outlive that.
 */

import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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

const LIGHT: Palette = {
  background: '#FFFFFF',
  surface: '#F2F4F8',
  text: '#101418',
  muted: '#5B6470',
  accent: '#1C4FD6',
  accentText: '#FFFFFF',
  danger: '#B42318',
  border: '#D6DAE1',
};

const DARK: Palette = {
  background: '#0B0E13',
  surface: '#171B22',
  text: '#F2F4F8',
  muted: '#9AA3AF',
  accent: '#6E93FF',
  accentText: '#0B0E13',
  danger: '#FF8A80',
  border: '#2A303A',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const palette = usePalette();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: palette.background }]}>
      <ScrollView contentContainerStyle={styles.screen} testID={testID}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
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
  const palette = usePalette();
  return (
    <Text testID={testID} style={[styles.body, { color: muted ? palette.muted : palette.text }]}>
      {children}
    </Text>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={[styles.section, { backgroundColor: palette.surface, borderColor: palette.border }]}
    >
      <Text style={[styles.sectionTitle, { color: palette.muted }]}>{title}</Text>
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
}: ButtonProps) {
  const palette = usePalette();
  const background =
    variant === 'primary' ? palette.accent : variant === 'danger' ? 'transparent' : palette.surface;
  const color =
    variant === 'primary'
      ? palette.accentText
      : variant === 'danger'
        ? palette.danger
        : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        disabled: disabled || busy,
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={disabled || busy}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: selected === true ? palette.accent : palette.border,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.buttonText, { color }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Loading({ label }: { label: string }) {
  const palette = usePalette();
  return (
    <View
      accessibilityLabel={label}
      style={[styles.fill, styles.center, { backgroundColor: palette.background }]}
    >
      <ActivityIndicator color={palette.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  screen: { padding: 20, gap: 16 },
  title: { fontSize: 28, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  section: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  button: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
