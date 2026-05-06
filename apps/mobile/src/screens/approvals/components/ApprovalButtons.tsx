import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { HoldToConfirm } from './HoldToConfirm';
import { DenyReasonSheet } from './DenyReasonSheet';

interface Props {
  isRecursive: boolean;
  inFlight: 'approve' | 'deny' | null;
  onApprove: () => void;
  onDeny: (reason?: string) => void;
}

export function ApprovalButtons({ isRecursive, inFlight, onApprove, onDeny }: Props) {
  const theme = useApprovalTheme('dark');
  const [denyOpen, setDenyOpen] = useState(false);
  const [biometricFailed, setBiometricFailed] = useState(false);

  async function handleApprovePress() {
    haptic.tap();
    setBiometricFailed(false);
    const hasHw = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();

    if (!hasHw || !enrolled) {
      // No biometric available — fall back to passcode prompt.
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm to approve',
        disableDeviceFallback: false,
      });
      if (!r.success) { setBiometricFailed(true); return; }
      onApprove();
      return;
    }

    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Approve this request',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    if (!r.success) { setBiometricFailed(true); return; }
    onApprove();
  }

  return (
    <View>
      {biometricFailed ? (
        <Text
          style={[
            type.meta,
            { color: theme.deny, paddingHorizontal: spacing[6], marginBottom: spacing[2] },
          ]}
        >
          Biometric failed. Try again.
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
              backgroundColor: pressed ? '#208c50' : theme.approve,
              alignItems: 'center',
              opacity: inFlight === 'approve' ? 0.6 : 1,
            })}
          >
            <Text style={[type.bodyMd, { color: '#04230f' }]}>Approve</Text>
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
