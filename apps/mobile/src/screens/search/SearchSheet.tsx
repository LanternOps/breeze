import { useEffect, useRef } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { useApprovalTheme, palette, radii, spacing, type } from '../../theme';
import type { MobileSearchResult } from '../../services/search';
import { track } from '../../lib/analytics';
import { useSearch } from './useSearch';

interface Props {
  visible: boolean;
  onCancel: () => void;
  onSelect: (result: MobileSearchResult) => void;
}

// 12px magnifying glass. Lives inline so the input can decorate without
// pulling a whole icon component just for two SVG primitives.
function SearchGlyph({ color, size = 12 }: { color: string; size?: number }) {
  // Stroke-only circle + a short diagonal tail.
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12">
      <Circle cx={5} cy={5} r={3.25} stroke={color} strokeWidth={1.4} fill="none" />
      <Line
        x1={7.5}
        y1={7.5}
        x2={10.5}
        y2={10.5}
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function severityColor(severity: string | undefined): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return palette.deny.base;
    case 'medium':
    case 'low':
      return palette.warning.base;
    default:
      return palette.dark.textLo;
  }
}

function kindColor(result: MobileSearchResult): string {
  if (result.kind === 'alert') return severityColor(result.meta.severity);
  if (result.kind === 'device') {
    return result.meta.status === 'online'
      ? palette.approve.base
      : palette.dark.textLo;
  }
  // session
  return palette.brand.soft;
}

function ResultRow({
  result,
  borderColor,
  onPress,
}: {
  result: MobileSearchResult;
  borderColor: string;
  onPress: () => void;
}) {
  const theme = useApprovalTheme('dark');
  const dot = kindColor(result);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        backgroundColor: pressed ? theme.bg2 : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: borderColor,
      })}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: dot,
          marginRight: spacing[3],
        }}
      />
      <View style={{ flex: 1, marginRight: spacing[3] }}>
        <Text
          style={[type.bodyMd, { color: theme.textHi }]}
          numberOfLines={1}
        >
          {result.title}
        </Text>
        {result.subtitle ? (
          <Text
            style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}
            numberOfLines={1}
          >
            {result.subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={[type.metaCaps, { color: theme.textLo }]}>
        {result.kind === 'session' ? 'CHAT' : result.kind.toUpperCase()}
      </Text>
    </Pressable>
  );
}

function SkeletonRow({ borderColor, bg }: { borderColor: string; bg: string }) {
  return (
    <View
      style={{
        paddingHorizontal: spacing[6],
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: borderColor,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: bg,
          marginRight: spacing[3],
        }}
      />
      <View style={{ flex: 1 }}>
        <View
          style={{ height: 14, backgroundColor: bg, borderRadius: radii.sm, width: '60%' }}
        />
        <View
          style={{
            height: 10,
            backgroundColor: bg,
            borderRadius: radii.sm,
            width: '35%',
            marginTop: spacing[2],
          }}
        />
      </View>
    </View>
  );
}

export function SearchSheet({ visible, onCancel, onSelect }: Props) {
  const theme = useApprovalTheme('dark');
  const { query, results, loading, error, setQuery, clear } = useSearch();
  const inputRef = useRef<TextInput | null>(null);

  // Auto-focus on open. iOS needs a tick after the modal animation begins
  // before the keyboard will reliably present; 60ms is enough in practice.
  useEffect(() => {
    if (!visible) {
      clear();
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [visible, clear]);

  // Fire `search_query` once per (trimmed) query that lands a non-loading
  // resolution — captures both successful searches and "no matches yet".
  // We dedupe on the resolved query so a re-render doesn't re-fire.
  const lastTrackedQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || loading || error) return;
    if (lastTrackedQueryRef.current === trimmedQuery) return;
    lastTrackedQueryRef.current = trimmedQuery;
    track('search_query', { result_count: results.length });
  }, [query, loading, error, results.length]);

  const handleSelect = (result: MobileSearchResult) => {
    track('search_result_tapped', { kind: result.kind });
    onSelect(result);
  };

  const trimmed = query.trim();
  const showSkeleton = loading && results.length === 0;
  const showEmptyHint = !trimmed && !loading && results.length === 0;
  const showNoMatches = !!trimmed && !loading && results.length === 0 && !error;

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

          <View style={{ paddingHorizontal: spacing[6] }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: theme.bg2,
                borderRadius: radii.md,
                paddingHorizontal: spacing[3],
                height: 40,
              }}
            >
              <SearchGlyph color={theme.textLo} />
              <TextInput
                ref={inputRef}
                value={query}
                onChangeText={setQuery}
                placeholder="Search devices, alerts, conversations"
                placeholderTextColor={theme.textLo}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel="Search"
                style={[
                  type.body,
                  {
                    flex: 1,
                    marginLeft: spacing[2],
                    color: theme.textHi,
                    paddingVertical: 0,
                  },
                ]}
              />
              {trimmed ? (
                <Pressable
                  onPress={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  hitSlop={8}
                  accessibilityLabel="Clear search"
                >
                  <Text style={[type.meta, { color: theme.textMd }]}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {error ? (
            <View
              style={{
                paddingHorizontal: spacing[6],
                paddingTop: spacing[4],
              }}
            >
              <Text style={[type.meta, { color: palette.deny.base }]}>
                Couldn't search. Try again.
              </Text>
            </View>
          ) : null}

          {showEmptyHint ? (
            <View
              style={{
                paddingHorizontal: spacing[6],
                paddingTop: spacing[5],
              }}
            >
              <Text style={[type.meta, { color: theme.textLo }]}>
                Try a hostname, alert title, or chat snippet.
              </Text>
            </View>
          ) : null}

          {showSkeleton ? (
            <View style={{ marginTop: spacing[4] }}>
              <SkeletonRow borderColor={theme.border} bg={theme.bg2} />
              <SkeletonRow borderColor={theme.border} bg={theme.bg2} />
              <SkeletonRow borderColor={theme.border} bg={theme.bg2} />
            </View>
          ) : null}

          {showNoMatches ? (
            <View
              style={{
                paddingHorizontal: spacing[6],
                paddingTop: spacing[5],
              }}
            >
              <Text style={[type.meta, { color: theme.textLo }]}>
                No matches yet. Keep typing.
              </Text>
            </View>
          ) : null}

          {results.length > 0 ? (
            <FlatList
              data={results}
              keyExtractor={(r) => `${r.kind}:${r.id}`}
              keyboardShouldPersistTaps="handled"
              style={{ marginTop: spacing[3] }}
              renderItem={({ item }) => (
                <ResultRow
                  result={item}
                  borderColor={theme.border}
                  onPress={() => handleSelect(item)}
                />
              )}
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
