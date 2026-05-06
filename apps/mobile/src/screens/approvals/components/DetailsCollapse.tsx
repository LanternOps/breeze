import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';

interface Props {
  toolName: string;
  args: Record<string, unknown>;
}

function prettyArgs(args: Record<string, unknown>): string {
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

export function DetailsCollapse({ toolName, args }: Props) {
  const theme = useApprovalTheme('dark');
  const [open, setOpen] = useState(false);

  return (
    <View
      style={{
        marginHorizontal: spacing[6],
        marginTop: spacing[5],
        borderRadius: radii.md,
        backgroundColor: theme.bg2,
        borderColor: theme.border,
        borderWidth: 1,
      }}
    >
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={{ padding: spacing[4], flexDirection: 'row', justifyContent: 'space-between' }}
      >
        <View style={{ flex: 1, marginRight: spacing[3] }}>
          <Text style={[type.metaCaps, { color: theme.textLo }]}>TOOL</Text>
          <Text style={[type.monoMd, { color: theme.textHi, marginTop: spacing[1] }]}>{toolName}</Text>
        </View>
        <Text style={[type.meta, { color: theme.textMd }]}>{open ? 'Hide' : 'Show'} details</Text>
      </Pressable>
      {open ? (
        <View
          style={{
            paddingHorizontal: spacing[4],
            paddingBottom: spacing[4],
            borderTopColor: theme.border,
            borderTopWidth: 1,
          }}
        >
          <Text
            style={[type.mono, { color: theme.textHi, marginTop: spacing[3] }]}
            selectable
          >
            {prettyArgs(args)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
