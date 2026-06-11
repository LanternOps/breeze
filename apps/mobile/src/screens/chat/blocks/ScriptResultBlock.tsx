import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { useApprovalTheme, palette, radii, spacing, type } from '../../../theme';
import { haptic } from '../../../lib/motion';

export interface ScriptResultLike {
  scriptName?: string | null;
  deviceId?: string | null;
  deviceHostname?: string | null;
  exitCode?: number | null;
  output?: string | null;
  error?: string | null;
  durationMs?: number | null;
}

interface Props {
  result: ScriptResultLike;
}

const MAX_OUTPUT_LINES = 12;

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function preview(output: string, max: number): { text: string; truncated: boolean } {
  const lines = output.split('\n');
  if (lines.length <= max) return { text: output, truncated: false };
  return { text: lines.slice(0, max).join('\n'), truncated: true };
}

// Card with script name headline, OK/Failed pill + duration, and a
// collapsible Output section. Tap output to expand inline; no drilldown.
export function ScriptResultBlock({ result }: Props) {
  const theme = useApprovalTheme('dark');
  const [expanded, setExpanded] = useState(false);

  const ok = result.exitCode === 0;
  const pillBg = ok ? palette.approve.wash : palette.deny.wash;
  const pillFg = ok ? palette.approve.base : palette.deny.base;
  const pillText = ok ? 'OK' : 'Failed';

  const duration = formatDuration(result.durationMs ?? null);
  const stream = result.error || result.output || '';
  const { text: previewText, truncated } = preview(stream, MAX_OUTPUT_LINES);
  const visible = expanded ? stream : previewText;

  const headline = result.scriptName ?? 'Script';
  const meta: string[] = [];
  if (duration) meta.push(duration);
  if (result.deviceHostname) meta.push(result.deviceHostname);

  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[3],
        backgroundColor: theme.bg2,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: theme.border,
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
      }}
    >
      <Text style={[type.bodyMd, { color: theme.textHi }]} numberOfLines={1}>
        {headline}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing[2] }}>
        <View
          style={{
            paddingHorizontal: spacing[2],
            paddingVertical: 2,
            borderRadius: radii.full,
            backgroundColor: pillBg,
          }}
        >
          <Text style={[type.metaCaps, { color: pillFg }]}>{pillText}</Text>
        </View>
        {meta.length > 0 ? (
          <Text style={[type.meta, { color: theme.textLo, marginLeft: spacing[2] }]} numberOfLines={1}>
            {meta.join(' · ')}
          </Text>
        ) : null}
      </View>

      {stream ? (
        <Pressable
          onPress={() => {
            haptic.tap();
            setExpanded((v) => !v);
          }}
          style={{ marginTop: spacing[3] }}
        >
          <Text style={[type.metaCaps, { color: theme.textLo }]}>
            {expanded ? 'OUTPUT · HIDE' : 'OUTPUT · SHOW'}
          </Text>
          {(expanded || truncated || stream.length > 0) ? (
            <Animated.View
              entering={FadeIn.duration(200)}
              exiting={FadeOut.duration(160)}
              style={{
                marginTop: spacing[2],
                backgroundColor: theme.bg1,
                borderRadius: radii.sm,
                paddingHorizontal: spacing[3],
                paddingVertical: spacing[2],
              }}
            >
              <Text style={[type.mono, { color: theme.textMd }]}>
                {visible}
              </Text>
              {!expanded && truncated ? (
                <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}>
                  Truncated. Tap to expand.
                </Text>
              ) : null}
            </Animated.View>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}
