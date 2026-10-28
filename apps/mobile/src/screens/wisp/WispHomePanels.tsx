import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { WispActivityItem } from '../../services/wisp';
import { radii, spacing, type, useApprovalTheme } from '../../theme';
import {
  activityGroups,
  linkKindLabel,
  linkTarget,
  type WispBriefSection,
  type WispThreadLink,
} from './wispHomeSections';

type Theme = ReturnType<typeof useApprovalTheme>;

/**
 * Wisp W08 (spec §17.2, w00 A35). The home sections the mobile thread screen
 * grows: the morning brief, the thread's entity links (read-only) and the full
 * activity timeline. Layout only — every decision is in `wispHomeSections.ts`.
 */

export function WispBriefCard({
  sections,
  theme,
}: {
  sections: WispBriefSection[];
  theme: Theme;
}): React.JSX.Element {
  return (
    <View
      testID="wisp-home-brief"
      style={{ marginTop: spacing[5], backgroundColor: theme.bg1, borderRadius: radii.lg, padding: spacing[5] }}
    >
      <Text style={[type.metaCaps, { color: theme.textLo }]}>MORNING BRIEF</Text>
      {sections.map((section, i) => (
        <View key={`${i}-${section.heading}`} style={{ marginTop: spacing[3] }}>
          <Text style={[type.bodyMd, { color: theme.textHi }]}>{section.heading}</Text>
          {section.lines.map((line, j) => (
            <Text key={j} style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>
              {`• ${line}`}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function WispLinksList({
  links,
  theme,
  onOpenTicket,
}: {
  links: WispThreadLink[];
  theme: Theme;
  onOpenTicket: (ticketId: string) => void;
}): React.JSX.Element | null {
  if (links.length === 0) return null;
  return (
    <View testID="wisp-home-links" style={{ marginTop: spacing[6] }}>
      <Text style={[type.metaCaps, { color: theme.textLo }]}>LINKED</Text>
      {links.map((link) => {
        const target = linkTarget(link);
        const body = (
          <>
            <Text style={[type.meta, { color: theme.textLo }]}>
              {linkKindLabel(link.ref.kind)}
              {link.status ? ` · ${link.status}` : ''}
              {link.source === 'wisp_pin' ? ' · added by Wisp' : ''}
            </Text>
            <Text
              style={[type.body, { color: target ? theme.brand : theme.textHi, marginTop: spacing[1] }]}
              numberOfLines={2}
            >
              {link.label}
            </Text>
          </>
        );
        const style = {
          marginTop: spacing[3],
          padding: spacing[4],
          borderRadius: radii.md,
          backgroundColor: theme.bg1,
          borderWidth: 1,
          borderColor: theme.border,
        };
        // Only tickets have an in-app screen reachable by id; the rest are
        // shown for context and stay read-only on the phone.
        return target ? (
          <Pressable
            key={link.id ?? `${link.ref.kind}:${link.ref.id}`}
            testID={`wisp-link-${link.id}`}
            accessibilityRole="link"
            onPress={() => onOpenTicket(target.ticketId)}
            style={style}
          >
            {body}
          </Pressable>
        ) : (
          <View key={link.id ?? `${link.ref.kind}:${link.ref.id}`} testID={`wisp-link-${link.id}`} style={style}>
            {body}
          </View>
        );
      })}
    </View>
  );
}

export function WispActivityTimeline({
  items,
  hasMore,
  loading,
  error,
  onLoadMore,
  theme,
}: {
  items: WispActivityItem[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  theme: Theme;
}): React.JSX.Element | null {
  if (items.length === 0 && !error) return null;
  const groups = activityGroups(items, new Date());
  return (
    <View testID="wisp-home-activity" style={{ marginTop: spacing[6] }}>
      <Text style={[type.metaCaps, { color: theme.textLo }]}>ACTIVITY</Text>
      {groups.map((group) => (
        <View key={group.key} style={{ marginTop: spacing[4] }}>
          <Text style={[type.meta, { color: theme.textMd }]}>{group.title}</Text>
          {group.items.map((item, i) => (
            <View
              key={`${item.at}|${item.kind}|${item.title}|${i}`}
              style={{ marginTop: spacing[2], paddingLeft: spacing[3], borderLeftWidth: 2, borderLeftColor: theme.border }}
            >
              <Text style={[type.body, { color: theme.textHi }]} numberOfLines={2}>
                {item.title}
              </Text>
              {item.detail ? (
                <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]} numberOfLines={3}>
                  {item.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      {error ? <Text style={[type.meta, { color: theme.deny, marginTop: spacing[3] }]}>{error}</Text> : null}
      {hasMore || error ? (
        <Pressable
          testID="wisp-home-activity-more"
          accessibilityRole="button"
          disabled={loading}
          onPress={onLoadMore}
          style={{ marginTop: spacing[4] }}
        >
          {loading ? (
            <ActivityIndicator color={theme.textMd} />
          ) : (
            <Text style={[type.bodyMd, { color: theme.brand }]}>{error ? 'Try again' : 'Show earlier activity'}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
