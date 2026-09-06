import { Text, View } from 'react-native';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { Spinner } from '../../../components/Spinner';
import { aiToolLabel, toolRowStatus, toolRowSuffix } from './toolIndicatorLogic';

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
}

export function ToolIndicator({ toolName, state, isError, output }: Props) {
  const theme = useApprovalTheme('dark');

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
          {aiToolLabel(toolName, 'running')}
        </Text>
      </View>
    );
  }

  // completed
  const status = toolRowStatus({ isError, output });
  // An approval handoff is the user's own decision landing, so it gets the
  // brand colour — the same one the approval takeover uses — not deny-red.
  const color =
    status === 'approved' ? theme.brand : status === 'completed' ? theme.textLo : theme.deny;

  return (
    <View style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[2] }}>
      <Text style={[type.metaCaps, { color }]} numberOfLines={1}>
        {`${aiToolLabel(toolName, 'completed')} · ${toolRowSuffix(status)}`}
      </Text>
    </View>
  );
}
