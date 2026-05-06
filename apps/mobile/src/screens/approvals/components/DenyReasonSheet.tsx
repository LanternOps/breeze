import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (reason: string | undefined) => void;
}

export function DenyReasonSheet({ visible, onCancel, onSubmit }: Props) {
  const theme = useApprovalTheme('dark');
  const [reason, setReason] = useState('');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={onCancel}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: theme.bg1,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            padding: spacing[6],
            paddingBottom: spacing[10],
          }}
        >
          <Text style={[type.title, { color: theme.textHi }]}>Why deny?</Text>
          <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
            Optional. Helps the requesting session understand.
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason"
            placeholderTextColor={theme.textLo}
            multiline
            style={[
              type.body,
              {
                color: theme.textHi,
                backgroundColor: theme.bg2,
                borderRadius: radii.md,
                padding: spacing[4],
                marginTop: spacing[4],
                minHeight: 88,
                textAlignVertical: 'top',
              },
            ]}
          />
          <View style={{ flexDirection: 'row', marginTop: spacing[5], gap: spacing[3] }}>
            <Pressable
              onPress={onCancel}
              style={{
                flex: 1,
                paddingVertical: spacing[4],
                alignItems: 'center',
                borderRadius: radii.md,
                backgroundColor: theme.bg2,
              }}
            >
              <Text style={[type.bodyMd, { color: theme.textHi }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onSubmit(reason.trim() || undefined)}
              style={{
                flex: 1,
                paddingVertical: spacing[4],
                alignItems: 'center',
                borderRadius: radii.md,
                backgroundColor: theme.deny,
              }}
            >
              <Text style={[type.bodyMd, { color: '#fff5f3' }]}>Deny</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
