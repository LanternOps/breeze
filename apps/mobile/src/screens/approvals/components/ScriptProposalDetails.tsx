import { useEffect, useState } from 'react';
import { reportInternalError } from '../../../lib/errorReporting';
import { Pressable, Text, View } from 'react-native';
import { useApprovalTheme, type, spacing, radii } from '../../../theme';
import { fetchScriptProposal } from '../../../services/approvals';
import {
  proposalDetailRows,
  findingLines,
  approveBlockedReason,
  type ScriptProposalDetailDto,
} from '../scriptProposalCopy';

interface Props {
  proposalId: string;
  /** Called whenever the acknowledged-pattern set changes, so ApprovalScreen
   *  can thread it into the approve POST body. */
  onAcknowledgementsChange: (acked: string[]) => void;
  /** Fires with the current approveBlockedReason (null = Approve allowed). */
  onApproveBlockedChange?: (reason: 'acknowledge' | 'permission' | null) => void;
}

const BLOCKED_REASON_COPY: Record<'acknowledge' | 'permission', string> = {
  acknowledge: 'Tick every strict pattern below before you can approve.',
  permission: "You don't have permission to acknowledge strict patterns on this proposal.",
};

/**
 * Structured detail card for a `script_proposal` approval (#5612 W03).
 *
 * Decision-free view: every row shown, every finding line, and whatever
 * blocks Approve is computed by `scriptProposalCopy.ts` — this component
 * only fetches the DTO, tracks which STRICT patterns are ticked, and renders.
 * Mirrors `UacInterceptDetails.tsx`'s card/collapse structure.
 */
export function ScriptProposalDetails({ proposalId, onAcknowledgementsChange, onApproveBlockedChange }: Props) {
  const theme = useApprovalTheme('dark');
  const [dto, setDto] = useState<ScriptProposalDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acked, setAcked] = useState<string[]>([]);
  const [bodyOpen, setBodyOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDto(null);
    setError(null);
    setAcked([]);
    fetchScriptProposal(proposalId)
      .then((result) => {
        if (cancelled) return;
        setDto(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        reportInternalError(err, 'approvals.scriptProposal');
        setError("Couldn't load this script proposal. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  useEffect(() => {
    onAcknowledgementsChange(acked);
  }, [acked, onAcknowledgementsChange]);

  const blockedNow = dto ? approveBlockedReason(dto, acked) : null;
  useEffect(() => {
    onApproveBlockedChange?.(blockedNow);
  }, [blockedNow, onApproveBlockedChange]);

  function toggleAck(pattern: string) {
    setAcked((prev) =>
      prev.includes(pattern) ? prev.filter((p) => p !== pattern) : [...prev, pattern]
    );
  }

  const cardStyle = {
    marginHorizontal: spacing[6],
    marginTop: spacing[5],
    borderRadius: radii.md,
    backgroundColor: theme.bg2,
    borderColor: theme.border,
    borderWidth: 1,
    padding: spacing[4],
  } as const;

  if (error) {
    return (
      <View style={cardStyle}>
        <Text style={[type.body, { color: theme.deny }]}>{error}</Text>
      </View>
    );
  }

  if (!dto) {
    return (
      <View style={cardStyle}>
        <Text style={[type.meta, { color: theme.textMd }]}>Loading script proposal…</Text>
      </View>
    );
  }

  const rows = proposalDetailRows(dto);
  const findings = findingLines(dto);
  const strictHits = dto.proposal.strictHits ?? [];
  const blockedReason = approveBlockedReason(dto, acked);

  return (
    <View>
      <View style={cardStyle}>
        <Text style={[type.metaCaps, { color: theme.textLo }]}>SCRIPT PROPOSAL</Text>
        <Text style={[type.bodyMd, { color: theme.textHi, marginTop: spacing[1] }]}>
          {dto.review?.summary ?? dto.proposal.goal}
        </Text>

        {rows.map((row) => (
          <View key={row.label} style={{ marginTop: spacing[3] }}>
            <Text style={[type.metaCaps, { color: theme.textLo }]}>{row.label}</Text>
            <Text style={[type.body, { color: theme.textHi, marginTop: spacing[1] }]} selectable>
              {row.value}
            </Text>
          </View>
        ))}

        {findings.length > 0 ? (
          <View style={{ marginTop: spacing[4] }}>
            <Text style={[type.metaCaps, { color: theme.textLo }]}>REVIEWER FINDINGS</Text>
            {findings.map((line, i) => (
              <Text
                key={i}
                style={[type.body, { color: theme.warning, marginTop: spacing[1] }]}
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        {strictHits.length > 0 ? (
          <View style={{ marginTop: spacing[4] }}>
            <Text style={[type.metaCaps, { color: theme.textLo }]}>STRICT PATTERNS — ACKNOWLEDGE EACH</Text>
            {strictHits.map((pattern) => {
              const isAcked = acked.includes(pattern);
              return (
                <Pressable
                  key={pattern}
                  onPress={() => toggleAck(pattern)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: spacing[2],
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isAcked }}
                >
                  <Text style={[type.bodyMd, { color: isAcked ? theme.approve : theme.textMd, marginRight: spacing[2] }]}>
                    {isAcked ? '✓' : '○'}
                  </Text>
                  <Text style={[type.mono, { color: theme.textHi, flex: 1 }]}>{pattern}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {blockedReason ? (
          <Text style={[type.meta, { color: theme.deny, marginTop: spacing[4] }]}>
            {BLOCKED_REASON_COPY[blockedReason]}
          </Text>
        ) : null}
      </View>

      <View style={[cardStyle, { marginTop: spacing[3] }]}>
        <Pressable
          onPress={() => setBodyOpen((v) => !v)}
          style={{ flexDirection: 'row', justifyContent: 'space-between' }}
        >
          <Text style={[type.metaCaps, { color: theme.textLo }]}>SCRIPT BODY ({dto.proposal.language})</Text>
          <Text style={[type.meta, { color: theme.textMd }]}>{bodyOpen ? 'Hide' : 'Show'}</Text>
        </Pressable>
        {bodyOpen ? (
          <Text style={[type.mono, { color: theme.textHi, marginTop: spacing[3] }]} selectable>
            {dto.proposal.content}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
