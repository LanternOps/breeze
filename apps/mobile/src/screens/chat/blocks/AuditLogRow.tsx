import { Text, View } from 'react-native';

import { useApprovalTheme, palette, spacing, type } from '../../../theme';
import { relativeTime } from '../../../lib/relativeTime';

export interface AuditEntryLike {
  id?: string;
  timestamp?: string | null;
  createdAt?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  action?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  details?: unknown;
}

interface Props {
  entries: AuditEntryLike[];
}

function actorDotColor(actorType: string | null | undefined): string {
  switch ((actorType ?? '').toLowerCase()) {
    case 'user':
      return palette.brand.base;
    case 'agent':
      return palette.warning.base;
    case 'system':
    default:
      return palette.dark.textLo;
  }
}

function actorLabel(entry: AuditEntryLike): string {
  if (entry.actorName) return entry.actorName;
  if (entry.actorType && entry.actorId) {
    return `${entry.actorType}:${entry.actorId.slice(0, 8)}`;
  }
  return entry.actorType ?? 'system';
}

// Compact one-line-per-entry stack with hairline dividers, no card chrome.
// No drilldown in v1 — audit details is heavy.
export function AuditLogRow({ entries }: Props) {
  const theme = useApprovalTheme('dark');

  if (entries.length === 0) return null;

  return (
    <View style={{ marginTop: spacing[3], paddingHorizontal: spacing[6] }}>
      {entries.map((e, i) => {
        const dot = actorDotColor(e.actorType);
        const time = relativeTime(e.timestamp ?? e.createdAt ?? null);
        const label = actorLabel(e);
        const action = e.action ?? 'event';
        const isLast = i === entries.length - 1;

        return (
          <View
            key={e.id ?? `audit-${i}`}
            style={{
              paddingVertical: spacing[2],
              borderBottomWidth: isLast ? 0 : 1,
              borderBottomColor: theme.border,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: dot,
                  marginRight: spacing[2],
                }}
              />
              <Text
                style={[type.monoMd, { color: theme.textHi, flex: 1 }]}
                numberOfLines={1}
              >
                {action}
              </Text>
            </View>
            <Text
              style={[type.meta, { color: theme.textLo, marginTop: spacing[1], marginLeft: 14 }]}
              numberOfLines={1}
            >
              {time ? `${label} · ${time}` : label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
