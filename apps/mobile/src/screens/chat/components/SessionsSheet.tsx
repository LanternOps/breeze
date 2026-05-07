import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from 'react-native';

import { useApprovalTheme, radii, spacing, type } from '../../../theme';
import { listAiSessions, type AiSessionListItem } from '../../../services/aiChat';

interface Props {
  visible: boolean;
  onCancel: () => void;
  onSelect: (sessionId: string) => void;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return 'just now';
  const m = Math.round(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

export function SessionsSheet({ visible, onCancel, onSelect }: Props) {
  const theme = useApprovalTheme('dark');
  const [sessions, setSessions] = useState<AiSessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSessions(null);
    setError(null);
    listAiSessions(30)
      .then(setSessions)
      .catch((err: Error) => setError(err.message));
  }, [visible]);

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
          <Text
            style={[
              type.title,
              { color: theme.textHi, paddingHorizontal: spacing[6] },
            ]}
          >
            History
          </Text>
          <Text
            style={[
              type.meta,
              { color: theme.textMd, paddingHorizontal: spacing[6], marginTop: spacing[1] },
            ]}
          >
            Past conversations on this account.
          </Text>

          {sessions === null && !error ? (
            <View style={{ paddingVertical: spacing[8], alignItems: 'center' }}>
              <ActivityIndicator color={theme.brand} />
            </View>
          ) : null}

          {error ? (
            <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4] }}>
              <Text style={[type.body, { color: theme.deny }]}>{error}</Text>
            </View>
          ) : null}

          {sessions && sessions.length === 0 ? (
            <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[4] }}>
              <Text style={[type.body, { color: theme.textMd }]}>
                No past conversations yet.
              </Text>
            </View>
          ) : null}

          {sessions && sessions.length > 0 ? (
            <FlatList
              data={sessions}
              keyExtractor={(s) => s.id}
              style={{ marginTop: spacing[2] }}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => onSelect(item.id)}
                  style={({ pressed }) => ({
                    paddingHorizontal: spacing[6],
                    paddingVertical: spacing[3],
                    backgroundColor: pressed ? theme.bg2 : 'transparent',
                  })}
                >
                  <Text
                    style={[type.bodyMd, { color: theme.textHi }]}
                    numberOfLines={1}
                  >
                    {item.title?.trim() || 'Untitled conversation'}
                  </Text>
                  <Text
                    style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}
                  >
                    {relativeTime(item.lastActivityAt ?? item.createdAt)} · {item.turnCount} turn
                    {item.turnCount === 1 ? '' : 's'}
                  </Text>
                </Pressable>
              )}
              ItemSeparatorComponent={() => (
                <View
                  style={{
                    height: 1,
                    backgroundColor: theme.border,
                    marginLeft: spacing[6],
                  }}
                />
              )}
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
