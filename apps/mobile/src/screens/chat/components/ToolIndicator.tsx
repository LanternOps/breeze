import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { Spinner } from '../../../components/Spinner';
import { haptic } from '../../../lib/motion';
import { aiToolLabel, toolRowErrorText, toolRowStatus, toolRowSuffix } from './toolIndicatorLogic';

interface Props {
  // The raw tool name, e.g. "manage_alerts". Rendered through `aiToolLabel`,
  // which conjugates it for the row's state ("Updating alerts" / "Updated
  // alerts") and falls back to title case for an unmapped tool.
  toolName: string;
  state: 'started' | 'completed';
  // Set from the SSE tool_result event. Together with `output` it decides the
  // completed row's caption and colour — see `toolRowStatus`, which classifies
  // an approved-and-executing handoff as APPROVED, never FAILED (#5107).
  isError?: boolean;
  output?: unknown;
  // Server-asserted approval handoff (#5107). Authoritative; `output` is only
  // a history-replay fallback because the tool controls that payload.
  handoff?: string;
  // The tool call's arguments (#5170). Lets `aiToolLabel` read `input.action`
  // so a read-only call ("list", "get", …) on a `manage_*` tool reads as
  // "Checked …" rather than "Updated …".
  input?: Record<string, unknown>;
}

export function ToolIndicator({ toolName, state, isError, output, handoff, input }: Props) {
  const theme = useApprovalTheme('dark');
  const [expanded, setExpanded] = useState(false);

  if (state === 'started') {
    return (
      <View
        style={{
          paddingHorizontal: spacing[6],
          paddingVertical: spacing[2],
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing[2],
        }}
      >
        <Spinner color={theme.brand} />
        <Text
          style={[type.metaCaps, { color: theme.textLo, flex: 1 }]}
          numberOfLines={1}
        >
          {aiToolLabel(toolName, 'running', input)}
        </Text>
      </View>
    );
  }

  // completed
  const status = toolRowStatus({ isError, output, handoff });
  // An approval handoff is the user's own decision landing, so it gets the
  // brand colour — the same one the approval takeover uses — not deny-red.
  const color =
    status === 'approved' ? theme.brand : status === 'completed' ? theme.textLo : theme.deny;

  const caption = (
    <Text style={[type.metaCaps, { color }]} numberOfLines={1}>
      {`${aiToolLabel(toolName, 'completed', input)} · ${toolRowSuffix(status)}`}
    </Text>
  );

  // FAILED/DENIED rows used to have no way to see why (#5170) — the comment
  // that used to live on `toolRowStatus` above documented the gap directly.
  // Completed/approved rows stay non-interactive; only these two get a tap
  // affordance, and only when there's actually error text to show.
  const errorText =
    status === 'failed' || status === 'denied' ? toolRowErrorText(output) : null;

  if (!errorText) {
    return (
      <View style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[2] }}>{caption}</View>
    );
  }

  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        setExpanded((v) => !v);
      }}
      accessibilityRole="button"
      accessibilityLabel="Show error"
      style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[2] }}
    >
      {caption}
      {expanded ? (
        <Text style={[type.mono, { color: theme.textLo, marginTop: spacing[1] }]}>{errorText}</Text>
      ) : null}
    </Pressable>
  );
}
