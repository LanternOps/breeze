import { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { changePassword } from '../../../services/api';
import { haptic } from '../../../lib/motion';

function EyeGlyph({ color, hidden }: { color: string; hidden: boolean }) {
  if (hidden) {
    return (
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path
          d="M3 3 L21 21"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          fill="none"
        />
        <Path
          d="M2.5 12 C 5 8, 8 5.5, 12 5.5 C 14 5.5, 15.7 6.1, 17.2 7.0 M21.5 12 C 19 16, 16 18.5, 12 18.5 C 10 18.5, 8.3 17.9, 6.8 17.0"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    );
  }
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M2.5 12 C 5 8, 8 5.5, 12 5.5 C 16 5.5, 19 8, 21.5 12 C 19 16, 16 18.5, 12 18.5 C 8 18.5, 5 16, 2.5 12 Z"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={12} cy={12} r={2.5} stroke={color} strokeWidth={1.75} fill="none" />
    </Svg>
  );
}

interface Props {
  visible: boolean;
  onCancel: () => void;
  onSuccess: () => void;
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  textColor: string;
  bg2: string;
  textLo: string;
}

function PasswordField({
  label,
  value,
  onChangeText,
  textColor,
  bg2,
  textLo,
}: FieldProps) {
  const [hidden, setHidden] = useState(true);
  return (
    <View style={{ marginTop: spacing[4] }}>
      <Text style={[type.metaCaps, { color: textLo, marginBottom: spacing[2] }]}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: bg2,
          borderRadius: radii.md,
          paddingRight: spacing[3],
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={hidden}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholderTextColor={textLo}
          style={[
            type.body,
            {
              color: textColor,
              padding: spacing[4],
              minHeight: 48,
              flex: 1,
            },
          ]}
        />
        <Pressable
          onPress={() => setHidden((v) => !v)}
          hitSlop={8}
          style={{
            width: 32,
            height: 32,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
        >
          <EyeGlyph color={textLo} hidden={hidden} />
        </Pressable>
      </View>
    </View>
  );
}

function validate(current: string, next: string, confirm: string): string | null {
  if (!current) return 'Current password is required.';
  if (!next) return 'New password is required.';
  if (next.length < 8) return 'New password must be at least 8 characters.';
  if (!/[A-Z]/.test(next)) return 'New password must contain an uppercase letter.';
  if (!/[a-z]/.test(next)) return 'New password must contain a lowercase letter.';
  if (!/[0-9]/.test(next)) return 'New password must contain a number.';
  if (next !== confirm) return 'New password does not match confirmation.';
  if (current === next) return 'New password must be different from the current one.';
  return null;
}

// Bottom sheet, paired with phase-1's DenyReasonSheet pattern. Slides up
// from the bottom over the SettingsSheet (which is already a Modal — RN
// stacks Modals so this works without nesting issues).
export function ChangePasswordSheet({ visible, onCancel, onSuccess }: Props) {
  const theme = useApprovalTheme('dark');
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setSubmitting(false);
  }

  function handleCancel() {
    reset();
    onCancel();
  }

  async function handleSubmit() {
    const err = validate(current, next, confirm);
    if (err) {
      Alert.alert('Check the password', err);
      return;
    }
    setSubmitting(true);
    haptic.tap();
    try {
      await changePassword(current, next);
      reset();
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not change password.';
      Alert.alert('Failed', msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleCancel}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={handleCancel}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.bg1,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            padding: spacing[6],
            paddingBottom: insets.bottom + spacing[6],
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.bg3,
              marginBottom: spacing[4],
            }}
          />
          <Text style={[type.title, { color: theme.textHi }]}>Change password</Text>
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
            8+ characters, with at least one uppercase, lowercase, and number.
          </Text>

          <PasswordField
            label="CURRENT"
            value={current}
            onChangeText={setCurrent}
            textColor={theme.textHi}
            bg2={theme.bg2}
            textLo={theme.textLo}
          />
          <PasswordField
            label="NEW"
            value={next}
            onChangeText={setNext}
            textColor={theme.textHi}
            bg2={theme.bg2}
            textLo={theme.textLo}
          />
          <PasswordField
            label="CONFIRM NEW"
            value={confirm}
            onChangeText={setConfirm}
            textColor={theme.textHi}
            bg2={theme.bg2}
            textLo={theme.textLo}
          />

          <View style={{ flexDirection: 'row', marginTop: spacing[6], gap: spacing[3] }}>
            <Pressable
              onPress={handleCancel}
              disabled={submitting}
              style={{
                flex: 1,
                paddingVertical: spacing[4],
                alignItems: 'center',
                borderRadius: radii.lg,
                backgroundColor: theme.bg2,
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <Text style={[type.bodyMd, { color: theme.textHi }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              disabled={submitting}
              style={{
                flex: 1.4,
                paddingVertical: spacing[4],
                alignItems: 'center',
                borderRadius: radii.lg,
                backgroundColor: theme.brand,
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <Text style={[type.bodyMd, { color: palette.approve.onBase }]}>
                {submitting ? 'Saving' : 'Save'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
