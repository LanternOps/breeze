/**
 * Pure copy + row-shaping for the AI script-proposal approval detail (#5612 W03).
 *
 * `ScriptProposalDetailDto` here mirrors the server contract in
 * `packages/shared/src/types/scriptProposals.ts`, scoped to the fields this
 * screen renders. `apps/mobile` deliberately has no `@breeze/shared`
 * dependency — Metro doesn't resolve workspace packages, so a workspace
 * import would bundle as a hard runtime failure rather than a build error
 * (see `services/authenticatorTranscript.ts`, `services/ticketPushPrefs.ts`,
 * `services/ticketAttachmentContract.ts` for the same pattern). This is an
 * honest mirror, not a re-export.
 *
 * Pure module — no React Native / Expo imports — so it is unit-testable in the
 * Vitest node environment, mirroring approvalCopy.ts. `ScriptProposalDetails.tsx`
 * is a thin, decision-free view: every row it shows and everything that blocks
 * Approve is computed here, not in the component.
 */

export interface ScriptProposalReviewFinding {
  severity: string;
  text: string;
  lineRef?: number;
}

export interface ScriptProposalDetailDto {
  proposal: {
    id: string;
    status: string;
    language: string;
    content: string;
    goal: string;
    expectedEffect: string;
    rollbackNote: string | null;
    verification: unknown;
    runAs: string;
    timeoutSeconds: number;
    strictHits: string[];
    touchClasses: string[];
    riskTier: string | null;
    createdAt?: string;
    expiresAt: string;
  };
  review: {
    summary: string | null;
    riskTier?: string | null;
    findings: ScriptProposalReviewFinding[];
    blastRadius?: string[];
  } | null;
  devices: Array<{ id: string; hostname: string; osType: string | null; status: string }>;
  viewer: { canDecide: boolean; canAcknowledge: boolean; canPromote: boolean };
}

export interface ProposalRow {
  label: string;
  value: string;
}

/** Best-effort human rendering of the proposal's verification descriptor —
 *  shape is server-defined and not yet pinned to one schema. */
function formatVerification(v: unknown): string {
  if (v == null) return 'Not specified';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind : null;
    const rest = Object.entries(o)
      .filter(([k]) => k !== 'kind')
      .map(([k, val]) => `${k}=${String(val)}`)
      .join(', ');
    if (kind) return rest ? `${kind} (${rest})` : kind;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatDevice(devices: ScriptProposalDetailDto['devices'] | undefined): string {
  const list = devices ?? [];
  if (list.length === 0) return 'No target device';
  if (list.length === 1) return list[0]!.hostname;
  return `${list.length} devices`;
}

/**
 * Ordered detail rows for the proposal card body. A ROLLBACK row is added
 * only when the proposal names one — most proposals don't, and an empty
 * "None" row would just be noise.
 */
export function proposalDetailRows(dto: ScriptProposalDetailDto): ProposalRow[] {
  const proposal = dto.proposal ?? ({} as ScriptProposalDetailDto['proposal']);
  const rows: ProposalRow[] = [
    { label: 'GOAL', value: proposal.goal ?? '' },
    { label: 'EXPECTED EFFECT', value: proposal.expectedEffect ?? '' },
    { label: 'VERIFICATION', value: formatVerification(proposal.verification) },
    { label: 'DEVICE', value: formatDevice(dto.devices) },
    { label: 'RUNS AS', value: proposal.runAs === 'user' ? 'User' : 'System' },
    { label: 'TOUCHES', value: (proposal.touchClasses ?? []).join(', ') || 'None' },
  ];
  if (proposal.rollbackNote) {
    rows.push({ label: 'ROLLBACK', value: proposal.rollbackNote });
  }
  return rows;
}

/**
 * `[severity] text` for every reviewer finding — empty (never undefined) when
 * there is no review yet (a proposal can reach the approver before its
 * automated review has completed).
 */
export function findingLines(dto: ScriptProposalDetailDto): string[] {
  const findings = dto.review?.findings ?? [];
  return findings.map((f) => `[${f.severity}] ${f.text}`);
}

/**
 * What (if anything) blocks Approve right now.
 *
 * Permission is checked BEFORE acknowledgement: telling an approver who
 * cannot acknowledge STRICT patterns to "tick every box" is actively
 * misleading — no amount of ticking unblocks them, only a different approver
 * (or a permission change) does. So this reports `'permission'` ahead of
 * `'acknowledge'` even when every box happens to already be ticked locally —
 * the server enforces the acknowledgement write via `scripts:write`, not the
 * client's local checklist state.
 */
export function approveBlockedReason(
  dto: ScriptProposalDetailDto,
  acked: string[],
): 'acknowledge' | 'permission' | null {
  const strictHits = dto.proposal?.strictHits ?? [];
  if (strictHits.length === 0) return null;
  if (!dto.viewer?.canAcknowledge) return 'permission';
  const ackedSet = new Set(acked);
  const allAcked = strictHits.every((hit) => ackedSet.has(hit));
  return allAcked ? null : 'acknowledge';
}
