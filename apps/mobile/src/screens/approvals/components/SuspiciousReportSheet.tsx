import { Modal, Pressable, Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii, palette } from '../../../theme';

interface Props {
  visible: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// "This wasn't me." — tertiary affordance on the takeover screen. Treats the
// in-flight approval as malicious: server denies the approval, revokes the
// requesting OAuth client, signs out its refresh tokens, writes a security
// audit row.
export function SuspiciousReportSheet({ visible, busy, onCancel, onConfirm }: Props) {
  const theme = useApprovalTheme('dark');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={busy ? undefined : onCancel}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.bg1,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            paddingTop: spacing[5],
            paddingHorizontal: spacing[6],
            paddingBottom: spacing[10],
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.bg3,
              marginBottom: spacing[5],
            }}
          />
          <Text style={[type.title, { color: theme.textHi }]}>Report as suspicious</Text>
          <Text style={[type.body, { color: theme.textMd, marginTop: spacing[2] }]}>
            This wasn't me. Treat this approval as malicious. We'll revoke the requesting app and sign out its session.
          </Text>

          <Pressable
            disabled={busy}
            onPress={onConfirm}
            style={{
              marginTop: spacing[6],
              paddingVertical: spacing[4],
              alignItems: 'center',
              borderRadius: radii.md,
              backgroundColor: theme.deny,
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Text style={[type.bodyMd, { color: palette.deny.onBase }]}>
              {busy ? 'Revoking…' : 'Revoke and sign out the requester'}
            </Text>
          </Pressable>

          <Pressable
            disabled={busy}
            onPress={onCancel}
            style={{
              marginTop: spacing[3],
              paddingVertical: spacing[4],
              alignItems: 'center',
              borderRadius: radii.md,
              backgroundColor: theme.bg2,
            }}
          >
            <Text style={[type.bodyMd, { color: theme.textHi }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
