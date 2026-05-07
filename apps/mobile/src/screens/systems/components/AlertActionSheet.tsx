import { Modal, Pressable, Text, View } from 'react-native';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import type { Alert } from '../../../services/api';

interface Props {
  visible: boolean;
  alert: Alert | null;
  onClose: () => void;
  onAcknowledge: () => void;
  onCopyId: () => void;
}

// Bottom-anchored action sheet for an alert row. Shows Acknowledge (when
// the alert is not yet acked) and Copy alert ID. Resolve and Mute are
// intentionally omitted in v1 — no mobile-surfaced API for them yet.
export function AlertActionSheet({
  visible,
  alert,
  onClose,
  onAcknowledge,
  onCopyId,
}: Props) {
  const theme = useApprovalTheme('dark');
  const showAcknowledge = !!alert && !alert.acknowledged;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          justifyContent: 'flex-end',
        }}
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.bg1,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            paddingTop: spacing[3],
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
              marginBottom: spacing[2],
            }}
          />

          {alert ? (
            <View
              style={{
                paddingHorizontal: spacing[6],
                paddingTop: spacing[2],
                paddingBottom: spacing[3],
              }}
            >
              <Text
                style={[type.bodyMd, { color: theme.textHi }]}
                numberOfLines={2}
              >
                {alert.title}
              </Text>
              {alert.deviceName ? (
                <Text
                  style={[
                    type.meta,
                    { color: theme.textMd, marginTop: spacing[1] },
                  ]}
                  numberOfLines={1}
                >
                  {alert.deviceName}
                </Text>
              ) : null}
            </View>
          ) : null}

          <View
            style={{
              height: 1,
              backgroundColor: theme.border,
              marginHorizontal: spacing[6],
              marginBottom: spacing[2],
            }}
          />

          {showAcknowledge ? (
            <ActionRow
              label="Acknowledge"
              onPress={onAcknowledge}
              theme={theme}
            />
          ) : null}

          <ActionRow label="Copy alert ID" onPress={onCopyId} theme={theme} />

          <View
            style={{
              height: 1,
              backgroundColor: theme.border,
              marginHorizontal: spacing[6],
              marginTop: spacing[2],
              marginBottom: spacing[2],
            }}
          />

          <ActionRow label="Cancel" onPress={onClose} theme={theme} muted />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionRow({
  label,
  onPress,
  theme,
  muted,
}: {
  label: string;
  onPress: () => void;
  theme: ReturnType<typeof useApprovalTheme>;
  muted?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingHorizontal: spacing[6],
        justifyContent: 'center',
        backgroundColor: pressed ? theme.bg2 : 'transparent',
      })}
    >
      <Text
        style={[type.bodyMd, { color: muted ? theme.textMd : theme.textHi }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
