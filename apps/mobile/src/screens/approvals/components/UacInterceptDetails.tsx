import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { extractUacDetails } from '../approvalCopy';

interface Props {
  args: Record<string, unknown>;
}

interface DetailRow {
  label: string;
  value: string;
}

/**
 * Structured detail card for a uac_intercept elevation approval (#1154).
 *
 * Replaces the generic raw-JSON DetailsCollapse for this flow: the most
 * decision-relevant fact (the signer) stays visible on the collapsed card, and
 * expanding reveals the full mono details — executable path, SHA-256, parent
 * process, and the requester's reason — so the approver can judge the elevation
 * without parsing JSON.
 */
export function UacInterceptDetails({ args }: Props) {
  const theme = useApprovalTheme('dark');
  const [open, setOpen] = useState(false);
  const d = extractUacDetails(args);

  const rows: DetailRow[] = [
    { label: 'EXECUTABLE', value: d.exePath ?? 'Unknown' },
    { label: 'SIGNER', value: d.signer ?? 'Unsigned' },
    { label: 'HASH (SHA-256)', value: d.hash ?? 'Unknown' },
    { label: 'PARENT PROCESS', value: d.parentProcess ?? 'Unknown' },
  ];
  if (d.reason) rows.push({ label: 'REQUESTER REASON', value: d.reason });
  if (d.intentSummary) rows.push({ label: 'INTENT', value: d.intentSummary });

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
          <Text style={[type.metaCaps, { color: theme.textLo }]}>ELEVATION</Text>
          <Text
            style={[type.monoMd, { color: theme.textHi, marginTop: spacing[1] }]}
            numberOfLines={1}
          >
            {d.signer ?? 'Unsigned executable'}
          </Text>
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
          {rows.map((row) => (
            <View key={row.label} style={{ marginTop: spacing[3] }}>
              <Text style={[type.metaCaps, { color: theme.textLo }]}>{row.label}</Text>
              <Text style={[type.mono, { color: theme.textHi, marginTop: spacing[1] }]} selectable>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
