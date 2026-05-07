import { Text, View } from 'react-native';

import { useApprovalTheme, spacing, type } from '../../../theme';
import { Spinner } from '../../../components/Spinner';

interface Props {
  // The verb form for in-flight ("CHECKING FLEET") OR the completed form
  // ("BREEZE.FLEET.STATUS · COMPLETED") depending on `state`.
  toolName: string;
  state: 'started' | 'completed';
  // When true on a completed event, the indicator renders in deny-red as
  // "DENIED" / "FAILED". Used for approval rejections and tool errors so
  // the chat thread carries an audit trail without an inline approval card.
  isError?: boolean;
}

// Tool name in dot-separated form, e.g. "breeze.fleet.status" → "BREEZE.FLEET.STATUS".
function format(toolName: string): string {
  return toolName.toUpperCase();
}

// Strips the namespace and converts to a verb-y caption for the streaming
// state. "breeze.fleet.status" → "CHECKING FLEET". Pure heuristic; the AI
// agent will eventually emit a friendly label and we can drop this.
function captionFor(toolName: string): string {
  const last = toolName.split('.').pop() ?? toolName;
  const map: Record<string, string> = {
    list: 'LISTING',
    get: 'FETCHING',
    search: 'SEARCHING',
    status: 'CHECKING',
    summary: 'SUMMARIZING',
    metrics: 'COLLECTING',
    run: 'RUNNING',
    delete: 'DELETING',
    create: 'CREATING',
    update: 'UPDATING',
  };
  for (const [key, verb] of Object.entries(map)) {
    if (last.toLowerCase().includes(key)) {
      const subject = toolName.split('.').slice(-2, -1)[0]?.toUpperCase() ?? last.toUpperCase();
      return `${verb} ${subject}`;
    }
  }
  return `RUNNING ${last.toUpperCase()}`;
}

// Heuristic: a permission-style error reads as "DENIED"; everything else
// is "FAILED". We can't distinguish approval-rejection from a generic tool
// error from the SSE payload alone, so we sniff the output text for known
// rejection phrases the SDK emits.
function isDenialOutput(output: unknown): boolean {
  if (!output) return false;
  const text =
    typeof output === 'string'
      ? output
      : typeof output === 'object' && output !== null && 'error' in output
        ? String((output as { error?: unknown }).error ?? '')
        : '';
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('rejected') || lower.includes('denied') || lower.includes('not approved');
}

export function ToolIndicator({ toolName, state, isError, output }: Props & { output?: unknown }) {
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
          {captionFor(toolName)}
        </Text>
      </View>
    );
  }

  // completed
  let suffix = 'COMPLETED';
  let color: string = theme.textLo;
  if (isError) {
    suffix = isDenialOutput(output) ? 'DENIED' : 'FAILED';
    color = theme.deny;
  }

  return (
    <View style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[2] }}>
      <Text style={[type.metaCaps, { color }]} numberOfLines={1}>
        {`${format(toolName)} · ${suffix}`}
      </Text>
    </View>
  );
}
