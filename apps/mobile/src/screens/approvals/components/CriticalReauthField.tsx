import { Pressable, Text, TextInput, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import type { ReauthMode } from '../criticalReauth';

interface Props {
  mode: ReauthMode;
  value: string;
  onChangeMode: (mode: ReauthMode) => void;
  onChangeValue: (value: string) => void;
  editable: boolean;
}

/**
 * #4052: re-authentication for a critical-tier (L4) approval. Controlled by
 * ApprovalScreen, which clears the value the moment Approve is pressed and
 * whenever focus moves to another request. The secret is never persisted.
 */
export function CriticalReauthField({ mode, value, onChangeMode, onChangeValue, editable }: Props) {
  const theme = useApprovalTheme('dark');
  const isCode = mode === 'totp';
  return (
    <View
      testID="approval-critical-reauth"
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[4],
        padding: spacing[4],
        borderRadius: radii.md,
        backgroundColor: theme.bg1,
      }}
    >
      <Text style={[type.body, { color: theme.textHi }]}>Confirm it’s you</Text>
      <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
        Critical requests need your account password (or the code from your authenticator app) as well as this
        device. It is checked once and never stored.
      </Text>
      <TextInput
        // Remount on mode change so a typed password never carries into the
        // code field (or the reverse).
        key={mode}
        testID="approval-critical-reauth-input"
        value={value}
        onChangeText={onChangeValue}
        editable={editable}
        placeholder={isCode ? 'Authenticator code' : 'Account password'}
        placeholderTextColor={theme.textLo}
        accessibilityLabel={isCode ? 'Authenticator app code' : 'Account password'}
        secureTextEntry={!isCode}
        keyboardType={isCode ? 'number-pad' : 'default'}
        textContentType={isCode ? 'oneTimeCode' : 'password'}
        autoComplete={isCode ? 'one-time-code' : 'current-password'}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={isCode ? 16 : 256}
        style={[
          type.body,
          {
            color: theme.textHi,
            backgroundColor: theme.bg2,
            borderRadius: radii.md,
            padding: spacing[4],
            marginTop: spacing[3],
          },
        ]}
      />
      {isCode ? (
        <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[2] }]}>
          Signed in with SSO? Use your authenticator app. A passkey alone can’t approve critical requests yet, so
          ask another approver if you have no authenticator app.
        </Text>
      ) : null}
      <Pressable
        onPress={() => {
          onChangeValue('');
          onChangeMode(isCode ? 'password' : 'totp');
        }}
        disabled={!editable}
        hitSlop={8}
        accessibilityRole="button"
        testID="approval-critical-reauth-mode"
        style={{ marginTop: spacing[3] }}
      >
        <Text style={[type.meta, { color: theme.brand }]}>
          {isCode ? 'Use my password instead' : 'Use an authenticator code instead'}
        </Text>
      </Pressable>
    </View>
  );
}
