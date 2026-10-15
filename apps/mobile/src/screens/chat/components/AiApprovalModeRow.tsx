import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { useAppSelector } from '../../../store';
import { spacing, type, useApprovalTheme } from '../../../theme';
import { getAiApprovalMode } from '../../../services/aiChat';
import { approvalModeCopy, type AiApprovalMode } from '../../../services/aiApprovalMode';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; mode: AiApprovalMode | null }
  | { kind: 'failed' };

/**
 * Read-only: the approval mode is an organization policy (partner default →
 * org setting, edited under AI Usage on the web) that the server enforces on
 * every message. Showing it here tells a technician why a multi-step task
 * asks once per step, and where that is changed. See services/aiApprovalMode.ts.
 *
 * Read for the open chat's org: a partner-scope token (an MSP technician) has
 * no org of its own, so without one the server can only answer "no budget".
 * With no chat open it falls back to the caller's own org.
 */
export function AiApprovalModeRow() {
  const theme = useApprovalTheme('dark');
  const orgId = useAppSelector((s) => s.aiChat.sessionOrgId);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    getAiApprovalMode(orgId)
      .then((mode) => {
        if (!cancelled) setState({ kind: 'loaded', mode });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const copy = approvalModeCopy(state.kind === 'loaded' ? state.mode : null);
  const value =
    state.kind === 'loading' ? 'Loading…' : state.kind === 'failed' ? 'Could not load' : copy.label;

  return (
    <View
      style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[3] }}
      testID="settings-ai-approval-mode"
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={[type.bodyMd, { color: theme.textHi }]}>Approvals</Text>
        <Text style={[type.meta, { color: theme.textMd, marginLeft: spacing[3], flexShrink: 1 }]} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Text style={[type.meta, { color: theme.textLo, marginTop: spacing[1] }]}>{copy.description}</Text>
    </View>
  );
}
