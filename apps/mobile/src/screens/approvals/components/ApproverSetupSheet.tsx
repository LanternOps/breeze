import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import {
  hasRegisteredApprover,
  registerApproverDevice,
  setApproverPin,
} from '../../../services/approverDevice';
import { getHardwareSigner } from '../../../services/hardwareSigner';

/**
 * Breeze Authenticator (Phase 3) setup sheet — register this phone as a
 * hardware-key approver and set the approval PIN. Thin presentation over the
 * (unit-tested) `approverDevice` service; the actual Secure-Enclave key
 * creation + biometric signing is exercised on a physical dev-client build.
 */
export function ApproverSetupSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useApprovalTheme();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [registered, setRegistered] = useState(false);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState<null | 'register' | 'pin'>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    void (async () => {
      setAvailable(await getHardwareSigner().isAvailable());
      setRegistered(await hasRegisteredApprover());
    })();
  }, [visible]);

  async function handleRegister() {
    setBusy('register');
    setMessage(null);
    try {
      await registerApproverDevice(password, 'This device');
      setRegistered(true);
      setPassword('');
      setMessage({ kind: 'ok', text: 'This device is now a trusted approver.' });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Registration failed.' });
    } finally {
      setBusy(null);
    }
  }

  async function handleSetPin() {
    if (!/^\d{4,6}$/.test(pin)) {
      setMessage({ kind: 'err', text: 'PIN must be 4–6 digits.' });
      return;
    }
    setBusy('pin');
    setMessage(null);
    try {
      await setApproverPin(password, pin);
      setPin('');
      setPassword('');
      setMessage({ kind: 'ok', text: 'Approval PIN set.' });
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Could not set PIN.' });
    } finally {
      setBusy(null);
    }
  }

  const inputStyle = {
    ...type.body,
    color: t.textHi,
    backgroundColor: t.bg2,
    borderRadius: radii.lg,
    padding: spacing[4],
  } as const;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View style={{ backgroundColor: t.bg1, borderTopLeftRadius: radii.lg, borderTopRightRadius: radii.lg, padding: spacing[6], maxHeight: '85%' }}>
          <ScrollView>
            <Text style={{ ...type.title, color: t.textHi, marginBottom: spacing[3] }}>Approver setup</Text>
            <Text style={{ ...type.body, color: t.textMd, marginBottom: spacing[6] }}>
              Register this device so high-risk approvals are signed with your biometric, and set a
              PIN for the most sensitive actions.
            </Text>

            {available === false && (
              <Text style={{ ...type.body, color: t.warning, marginBottom: spacing[4] }}>
                This device has no biometric hardware key available. You can still approve requests;
                they’ll be recorded without device verification.
              </Text>
            )}

            <Text style={{ ...type.meta, color: t.textMd, marginBottom: spacing[2] }}>Account password</Text>
            <TextInput
              testID="approver-password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              placeholder="Required to register / set PIN"
              placeholderTextColor={t.textLo}
              style={{ ...inputStyle, marginBottom: spacing[6] }}
            />

            <Pressable
              testID="approver-register"
              disabled={busy !== null || available === false || !password}
              onPress={handleRegister}
              style={{ backgroundColor: registered ? t.bg2 : t.brand, borderRadius: radii.lg, padding: spacing[4], alignItems: 'center', marginBottom: spacing[6], opacity: busy || available === false || !password ? 0.6 : 1 }}
            >
              {busy === 'register' ? (
                <ActivityIndicator color={t.textHi} />
              ) : (
                <Text style={{ ...type.bodyMd, color: registered ? t.textHi : '#fff' }}>
                  {registered ? 'Re-register this device' : 'Register this device'}
                </Text>
              )}
            </Pressable>

            <Text style={{ ...type.meta, color: t.textMd, marginBottom: spacing[2] }}>Approval PIN (4–6 digits)</Text>
            <TextInput
              testID="approver-pin"
              secureTextEntry
              keyboardType="number-pad"
              value={pin}
              onChangeText={setPin}
              maxLength={6}
              placeholder="••••"
              placeholderTextColor={t.textLo}
              style={{ ...inputStyle, marginBottom: spacing[4] }}
            />
            <Pressable
              testID="approver-set-pin"
              disabled={busy !== null || !password || !pin}
              onPress={handleSetPin}
              style={{ backgroundColor: t.brand, borderRadius: radii.lg, padding: spacing[4], alignItems: 'center', opacity: busy || !password || !pin ? 0.6 : 1 }}
            >
              {busy === 'pin' ? <ActivityIndicator color="#fff" /> : <Text style={{ ...type.bodyMd, color: '#fff' }}>Set PIN</Text>}
            </Pressable>

            {message && (
              <Text testID="approver-message" style={{ ...type.body, color: message.kind === 'ok' ? t.approve : t.deny, marginTop: spacing[6] }}>
                {message.text}
              </Text>
            )}

            <Pressable testID="approver-close" onPress={onClose} style={{ padding: spacing[4], alignItems: 'center', marginTop: spacing[4] }}>
              <Text style={{ ...type.body, color: t.textMd }}>Close</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
