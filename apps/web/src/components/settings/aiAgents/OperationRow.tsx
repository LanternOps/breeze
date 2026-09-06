import type { AgentToolOperationDto } from '@breeze/shared';
import { badgeClass, type BadgeTone } from '../../aiAgents/statusBadge';
import type { OperationOutcome } from './capabilityModel';

/**
 * Outcome -> badge tone. `approval_request` (tier 3, shadow default) gets the
 * same warning tone as the act-mode card elsewhere in this form;
 * `logged_proposal` (tier 2) is the low-stakes `info` tone; `unattended`
 * (act mode, manifest-eligible) is the one outcome that bypasses a technician
 * entirely, so it gets the strongest tone even though nothing here is an
 * error.
 */
const OUTCOME_TONE: Record<OperationOutcome, BadgeTone> = {
  approval_request: 'warning',
  logged_proposal: 'info',
  unattended: 'danger',
};

export interface OperationRowProps {
  op: AgentToolOperationDto;
  /** Translated operation label (the tool's own label for a bare/single-op tool). */
  label: string;
  checked: boolean;
  /** False when the org's partner-wide baseline does not include this operation. */
  withinCeiling: boolean;
  outcome: OperationOutcome;
  outcomeLabel: string;
  /** Show the literal `tool` or `tool:action` key in mono, gated by the picker's "Show tool names" switch. */
  showKey: boolean;
  policyDecidableTitle: string;
  notInCeilingLabel: string;
  onToggle: (key: string) => void;
}

export default function OperationRow({
  op,
  label,
  checked,
  withinCeiling,
  outcome,
  outcomeLabel,
  showKey,
  policyDecidableTitle,
  notInCeilingLabel,
  onToggle,
}: OperationRowProps) {
  return (
    <li className="flex items-start gap-2 py-1.5 pl-6" data-testid={`operation-row-${op.key}`}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        checked={checked}
        disabled={!withinCeiling}
        onChange={() => onToggle(op.key)}
        data-testid={`operation-checkbox-${op.key}`}
      />
      <span className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span>{label}</span>
        {showKey && <span className="font-mono text-xs text-muted-foreground">{op.key}</span>}
        <span className={badgeClass(OUTCOME_TONE[outcome], { size: 'sm' })}>{outcomeLabel}</span>
        {op.policyDecidable && (
          <span
            aria-hidden="true"
            title={policyDecidableTitle}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
            data-testid={`operation-preauthorizable-${op.key}`}
          />
        )}
        {!withinCeiling && <span className={badgeClass('muted', { size: 'sm' })}>{notInCeilingLabel}</span>}
      </span>
    </li>
  );
}
