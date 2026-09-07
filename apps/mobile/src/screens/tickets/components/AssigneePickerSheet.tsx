import { FlatList, Modal, Pressable, Text, View } from 'react-native';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import type { AssigneeOption } from '../createTicketForm';

interface Props {
  visible: boolean;
  options: readonly AssigneeOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCancel: () => void;
}

/**
 * #5188: who the ticket is assigned to, defaulting to the signed-in tech.
 * `options` already encodes the degrade — when `GET /users` fails or the
 * tech lacks `users:read`, `createTicketForm.assigneeOptions` still returns
 * "Unassigned" + "(you)", so this component never needs its own error state.
 */
export function AssigneePickerSheet({ visible, options, selectedId, onSelect, onCancel }: Props) {
  const theme = useApprovalTheme('dark');

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
            paddingTop: spacing[5],
            paddingBottom: spacing[10],
            maxHeight: '70%',
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
          <Text style={[type.title, { color: theme.textHi, paddingHorizontal: spacing[6] }]}>
            Assignee
          </Text>

          <FlatList
            data={options}
            keyExtractor={(o) => o.id ?? 'unassigned'}
            style={{ marginTop: spacing[3] }}
            renderItem={({ item }) => {
              const active = item.id === selectedId;
              return (
                <Pressable
                  onPress={() => onSelect(item.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => ({
                    paddingHorizontal: spacing[6],
                    paddingVertical: spacing[3],
                    backgroundColor: pressed || active ? theme.bg2 : 'transparent',
                  })}
                >
                  <Text
                    style={[type.bodyMd, { color: active ? theme.textHi : theme.textMd }]}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
