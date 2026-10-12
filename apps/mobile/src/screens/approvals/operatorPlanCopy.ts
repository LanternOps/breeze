/**
 * Pure, defensive view of an `operator_plan` approval's arguments for the
 * mobile detail screen. No React Native imports (unit-testable in node).
 *
 * Mirrors the web card (OperatorPlanApprovalCard): stable provider order,
 * dispatch (ordinal) order inside each group, every effect kept — one approval
 * authorizes up to 64 effects and the approver must be able to read them all.
 */
import type { OperatorPlanEffect, OperatorPlanProvider } from '../../services/approvals';

export const OPERATOR_PLAN_PROVIDER_ORDER: readonly OperatorPlanProvider[] = ['breeze', 'm365', 'google'];

export const OPERATOR_PLAN_PROVIDER_LABEL: Record<OperatorPlanProvider, string> = {
  breeze: 'Breeze devices',
  m365: 'Microsoft 365',
  google: 'Google Workspace',
};

export interface OperatorPlanGroup {
  provider: OperatorPlanProvider;
  effects: OperatorPlanEffect[];
}

function isProvider(v: unknown): v is OperatorPlanProvider {
  return v === 'breeze' || v === 'm365' || v === 'google';
}

function parseEffects(value: unknown): OperatorPlanEffect[] | null {
  if (!Array.isArray(value)) return null;
  const out: OperatorPlanEffect[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    if (
      typeof e.ordinal !== 'number' || !Number.isFinite(e.ordinal) ||
      !isProvider(e.provider) ||
      typeof e.targetLabel !== 'string' ||
      typeof e.rendering !== 'string' ||
      (e.principalLabel != null && typeof e.principalLabel !== 'string')
    ) {
      return null;
    }
    out.push({
      ordinal: e.ordinal,
      provider: e.provider,
      toolName: typeof e.toolName === 'string' ? e.toolName : '',
      targetLabel: e.targetLabel,
      principalLabel: typeof e.principalLabel === 'string' ? e.principalLabel : null,
      rendering: e.rendering,
    });
  }
  return out;
}

/**
 * Groups the plan's effects by provider. Returns `null` when the payload is
 * malformed (any bad entry) so the screen shows an invalid state rather than a
 * partial plan the approver might sign; `[]` for a genuinely empty plan.
 */
export function groupOperatorPlanEffects(
  args: Record<string, unknown> | null | undefined,
): OperatorPlanGroup[] | null {
  const effects = parseEffects(args?.effects);
  if (effects === null) return null;
  return OPERATOR_PLAN_PROVIDER_ORDER.flatMap((provider) => {
    const group = effects.filter((e) => e.provider === provider).sort((a, b) => a.ordinal - b.ordinal);
    return group.length > 0 ? [{ provider, effects: group }] : [];
  });
}
