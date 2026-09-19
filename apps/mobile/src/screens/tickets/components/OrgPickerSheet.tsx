import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import type { OrgOption } from '../createTicketForm';

/** Above this many orgs the picker gets a search box (server-side search). */
const SEARCH_THRESHOLD = 8;

interface Props {
  visible: boolean;
  orgs: OrgOption[] | null;
  orgTotal: number;
  orgSearch: string;
  orgError: string | null;
  selectedOrgId: string | null;
  onSearchChange: (text: string) => void;
  onRetry: () => void;
  onSelect: (orgId: string) => void;
  onCancel: () => void;
}

/**
 * #5188: the organization list used to render inline on `CreateTicketScreen`
 * (every org as a full-width row), pushing Subject/Description off the fold
 * on any MSP with more than a handful of orgs. It now lives behind a
 * selector row + this bottom sheet — same `Modal` pattern as `SearchSheet` /
 * `SessionsSheet`, same search-and-list contents as before.
 */
export function OrgPickerSheet({
  visible,
  orgs,
  orgTotal,
  orgSearch,
  orgError,
  selectedOrgId,
  onSearchChange,
  onRetry,
  onSelect,
  onCancel,
}: Props) {
  const theme = useApprovalTheme('dark');
  const showSearch = orgTotal > SEARCH_THRESHOLD || orgSearch.length > 0;

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
            maxHeight: '80%',
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
            Organization
          </Text>

          {showSearch ? (
            <View style={{ paddingHorizontal: spacing[6], marginTop: spacing[4] }}>
              <TextInput
                style={[
                  type.body,
                  {
                    color: theme.textHi,
                    backgroundColor: theme.bg2,
                    borderRadius: radii.md,
                    paddingHorizontal: spacing[3],
                    paddingVertical: spacing[3],
                  },
                ]}
                placeholder="Search organizations"
                placeholderTextColor={theme.textLo}
                value={orgSearch}
                onChangeText={onSearchChange}
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel="Search organizations"
              />
            </View>
          ) : null}

          {orgError ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4] }}
            >
              <Text style={[type.meta, { color: theme.deny }]}>{orgError}</Text>
            </Pressable>
          ) : null}

          {orgs === null ? (
            <View style={{ paddingVertical: spacing[8], alignItems: 'center' }}>
              <ActivityIndicator color={theme.brand} />
            </View>
          ) : orgs.length === 0 && !orgError ? (
            <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4] }}>
              <Text style={[type.meta, { color: theme.textLo }]}>No organizations match.</Text>
            </View>
          ) : (
            <FlatList
              data={orgs}
              keyExtractor={(o) => o.id}
              keyboardShouldPersistTaps="handled"
              style={{ marginTop: spacing[3] }}
              renderItem={({ item }) => {
                const active = item.id === selectedOrgId;
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
                      {item.name}
                    </Text>
                  </Pressable>
                );
              }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
