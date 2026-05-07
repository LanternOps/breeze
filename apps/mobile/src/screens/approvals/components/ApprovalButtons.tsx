import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useApprovalTheme, type, spacing, radii, palette } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { HoldToConfirm } from './HoldToConfirm';
import { DenyReasonSheet } from './DenyReasonSheet';

interface Props {
  isRecursive: boolean;
  inFlight: 'approve' | 'deny' | null;
  onApprove: () => void;
  onDeny: (reason?: string) => void;
}

const SILENT_CANCEL_CODES = new Set(['user_cancel', 'system_cancel', 'app_cancel']);
const LOCKOUT_CODES = new Set(['lockout', 'lockout_permanent']);
const PASSCODE_FALLBACK_CODES = new Set(['not_enrolled', 'passcode_not_set']);

export function ApprovalButtons({ isRecursive, inFlight, onApprove, onDeny }: Props) {
  const theme = useApprovalTheme('dark');
  const [denyOpen, setDenyOpen] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  async function authenticateWithPasscode(): Promise<LocalAuthentication.LocalAuthenticationResult> {
    return await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm to approve',
      disableDeviceFallback: false,
    });
  }

  async function handleApprovePress() {
    haptic.tap();
    setAuthMessage(null);

    let hasHw = false;
    let enrolled = false;
    try {
      hasHw = await LocalAuthentication.hasHardwareAsync();
      enrolled = await LocalAuthentication.isEnrolledAsync();
    } catch (err) {
      console.warn('[ApprovalButtons] biometric hardware probe failed', err);
      hasHw = false;
      enrolled = false;
    }

    if (!hasHw || !enrolled) {
      const r = await authenticateWithPasscode();
      if (r.success) { onApprove(); return; }
      handleAuthFailure(r);
      return;
    }

    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Approve this request',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    if (r.success) { onApprove(); return; }

    const code = (r as { error?: string }).error;
    if (code && PASSCODE_FALLBACK_CODES.has(code)) {
      const fallback = await authenticateWithPasscode();
      if (fallback.success) { onApprove(); return; }
      handleAuthFailure(fallback);
      return;
    }
    handleAuthFailure(r);
  }

  function handleAuthFailure(result: LocalAuthentication.LocalAuthenticationResult) {
    const code = (result as { error?: string }).error;
    if (code && SILENT_CANCEL_CODES.has(code)) {
      setAuthMessage(null);
      return;
    }
    if (code && LOCKOUT_CODES.has(code)) {
      setAuthMessage('Biometrics locked. Use device passcode in Settings to unlock.');
      return;
    }
    setAuthMessage('Authentication failed. Try again.');
  }

  return (
    <View>
      {authMessage ? (
        <Text
          style={[
            type.meta,
            { color: theme.deny, paddingHorizontal: spacing[6], marginBottom: spacing[2] },
          ]}
        >
          {authMessage}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', paddingHorizontal: spacing[6], gap: spacing[3] }}>
        <Pressable
          onPress={() => { haptic.tap(); setDenyOpen(true); }}
          disabled={inFlight !== null}
          style={({ pressed }) => ({
            flex: 1,
            paddingVertical: spacing[5],
            borderRadius: radii.lg,
            backgroundColor: pressed ? theme.bg3 : theme.bg2,
            alignItems: 'center',
            opacity: inFlight === 'deny' ? 0.6 : 1,
          })}
        >
          <Text style={[type.bodyMd, { color: theme.textHi }]}>Deny</Text>
        </Pressable>

        {isRecursive ? (
          <View style={{ flex: 1.4 }}>
            <HoldToConfirm label="Hold to approve" onComplete={handleApprovePress} />
          </View>
        ) : (
          <Pressable
            onPress={handleApprovePress}
            disabled={inFlight !== null}
            style={({ pressed }) => ({
              flex: 1.4,
              paddingVertical: spacing[5],
              borderRadius: radii.lg,
              backgroundColor: pressed ? palette.approve.pressed : theme.approve,
              alignItems: 'center',
              opacity: inFlight === 'approve' ? 0.6 : 1,
            })}
          >
            <Text style={[type.bodyMd, { color: palette.approve.onBase }]}>Approve</Text>
          </Pressable>
        )}
      </View>

      <DenyReasonSheet
        visible={denyOpen}
        onCancel={() => setDenyOpen(false)}
        onSubmit={(reason) => { setDenyOpen(false); onDeny(reason); }}
      />
    </View>
  );
}
