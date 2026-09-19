import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import type { ContactOption } from '../createTicketForm';

/** Above this many rows the picker gets a search box (client-side filter). */
const SEARCH_THRESHOLD = 8;

interface Props {
  visible: boolean;
  /** `null` while the org's contacts are still loading. */
  options: ContactOption[] | null;
  /** Rows before the search filter — decides whether the search box is worth showing. */
  totalOptions: number;
  search: string;
  selectedId: string | null;
  onSearchChange: (text: string) => void;
  onSelect: (contactId: string | null) => void;
  onCancel: () => void;
}

/**
 * #5367: pick who a new ticket is FOR. Same `Modal` shape as `OrgPickerSheet`
 * (and deliberately not `AssigneePickerSheet`, which has no search) because a
 * customer org routinely has more contacts than a partner has staff.
 *
 * The search filter is client-side over the single page `listOrgContacts`
 * fetched — see `contactOptions`. "No contact" is always the first row and is
 * never filtered out, so clearing a pick stays reachable mid-search.
 */
export function ContactPickerSheet({
  visible,
  options,
  totalOptions,
  search,
  selectedId,
  onSearchChange,
  onSelect,
  onCancel,
}: Props) {
  const theme = useApprovalTheme('dark');
  const showSearch = totalOptions > SEARCH_THRESHOLD || search.length > 0;

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
            Contact
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
                placeholder="Search contacts"
                placeholderTextColor={theme.textLo}
                value={search}
                onChangeText={onSearchChange}
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel="Search contacts"
              />
            </View>
          ) : null}

          {options === null ? (
            <View style={{ paddingVertical: spacing[8], alignItems: 'center' }}>
              <ActivityIndicator color={theme.brand} />
            </View>
          ) : (
            <FlatList
              data={options}
              keyExtractor={(o) => o.id ?? 'none'}
              keyboardShouldPersistTaps="handled"
              style={{ marginTop: spacing[3] }}
              // Only the pinned "No contact" row survives a search that matches
              // nobody, and a lone row reads as "that IS the result" — say so.
              ListFooterComponent={
                options.length <= 1 && search.trim().length > 0 ? (
                  <Text
                    style={[
                      type.meta,
                      { color: theme.textLo, paddingHorizontal: spacing[6], paddingTop: spacing[3] },
                    ]}
                  >
                    No contacts match.
                  </Text>
                ) : null
              }
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
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
