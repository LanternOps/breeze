import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useApprovalTheme, type, spacing, radii, palette } from '../../../theme';
import { haptic } from '../../../lib/motion';
import { HoldToConfirm } from './HoldToConfirm';
import { DenyReasonSheet } from './DenyReasonSheet';
import { captureRequestId, type CapturedRequestId } from '../decisionTarget';
import { classifyAuthFailure } from '../authOutcome';

interface Props {
  // The approval the user is looking at right now (live prop). We snapshot
  // it via captureRequestId() at press time and thread the branded value
  // back through onApprove/onDeny so a focus swap during the (multi-second)
  // biometric prompt can't rebind consent to a different request. The brand
  // makes passing the live id straight through a compile error. See PR #696
  // Critical #3 / decisionTarget.ts.
  requestId: string;
  isRecursive: boolean;
  inFlight: 'approve' | 'deny' | null;
  /** Approve button label — flow-type aware (e.g. "Allow" for uac_intercept). */
  approveLabel?: string;
  /** Hold-to-confirm label for the recursive self-approval path. */
  holdLabel?: string;
  onApprove: (requestId: CapturedRequestId) => void;
  onDeny: (requestId: CapturedRequestId, reason?: string) => void;
}

const PASSCODE_FALLBACK_CODES = new Set(['not_enrolled', 'passcode_not_set']);

export function ApprovalButtons({
  requestId,
  isRecursive,
  inFlight,
  approveLabel = 'Approve',
  holdLabel = 'Hold to approve',
  onApprove,
  onDeny,
}: Props) {
  const theme = useApprovalTheme('dark');
  const [denyOpen, setDenyOpen] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  // Snapshot of the request id at the moment Deny was tapped — the deny
  // reason sheet stays open across re-renders, so reading the live prop in
  // its onSubmit would have the same focus-swap hazard as approve.
  const denyTargetRef = useRef<CapturedRequestId>(captureRequestId(requestId));

  async function authenticateWithPasscode(): Promise<LocalAuthentication.LocalAuthenticationResult> {
    return await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm to approve',
      disableDeviceFallback: false,
    });
  }

  async function handleApprovePress() {
    // Bind consent BEFORE the biometric modal. This branded local survives
    // any re-render/focus swap that happens while the OS prompt is up.
    const target = captureRequestId(requestId);
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

    // authenticateAsync / authenticateWithPasscode can REJECT (another
    // auth already in progress, Android activity-not-found, native module
    // error) — not just resolve {success:false}. Unguarded, that rejection
    // escapes as an unhandled promise rejection: no onApprove, no message.
    // The user taps Approve on a consent action and nothing happens with
    // zero feedback (#746 Issue 1). Catch it and surface a failure.
    try {
      if (!hasHw || !enrolled) {
        const r = await authenticateWithPasscode();
        if (r.success) { onApprove(target); return; }
        handleAuthFailure(r);
        return;
      }

      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Approve this request',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (r.success) { onApprove(target); return; }

      const code = (r as { error?: string }).error;
      if (code && PASSCODE_FALLBACK_CODES.has(code)) {
        const fallback = await authenticateWithPasscode();
        if (fallback.success) { onApprove(target); return; }
        handleAuthFailure(fallback);
        return;
      }
      handleAuthFailure(r);
    } catch (err) {
      console.warn('[ApprovalButtons] biometric auth threw', err);
      setAuthMessage('Authentication failed. Try again.');
    }
  }

  function handleAuthFailure(result: LocalAuthentication.LocalAuthenticationResult) {
    // Only user_cancel is a justified silent no-op. system_cancel /
    // app_cancel (OS/app interrupted the prompt — e.g. a second push
    // mid-confirmation) now surface an actionable retry instead of being
    // swallowed (#746 Issue 2). Classification is unit-tested in
    // authOutcome.test.ts.
    const { message } = classifyAuthFailure((result as { error?: string }).error);
    setAuthMessage(message);
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
          onPress={() => { denyTargetRef.current = captureRequestId(requestId); haptic.tap(); setDenyOpen(true); }}
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
            <HoldToConfirm label={holdLabel} onComplete={handleApprovePress} />
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
            <Text style={[type.bodyMd, { color: palette.approve.onBase }]}>{approveLabel}</Text>
          </Pressable>
        )}
      </View>

      <DenyReasonSheet
        visible={denyOpen}
        onCancel={() => setDenyOpen(false)}
        onSubmit={(reason) => { setDenyOpen(false); onDeny(denyTargetRef.current, reason); }}
      />
    </View>
  );
}
