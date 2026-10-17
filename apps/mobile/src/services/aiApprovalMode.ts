/**
 * The AI chat approval mode, as the phone sees it.
 *
 * The mode is an ORGANIZATION policy, not a per-user or per-chat choice. The
 * server resolves it per session org through the effective AI budget (partner
 * `aiBudgets` override → org `ai_budgets` row → `per_step`;
 * streamingSessionManager.ts `loadApprovalMode`) and re-reads it before every
 * message. The `approvalMode` field on `POST /ai/sessions` is stored on the
 * row but never consulted by the approval gate, so the phone does not send
 * one. Admins change the mode under Organization settings → AI on the web (AI Usage only displays it); the phone
 * shows it read-only so a technician can tell why a task asks once per step.
 */

export type AiApprovalMode = 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';

const MODES: readonly AiApprovalMode[] = ['per_step', 'action_plan', 'auto_approve', 'hybrid_plan'];

export function parseApprovalMode(value: unknown): AiApprovalMode | null {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
    ? (value as AiApprovalMode)
    : null;
}

/** `GET /ai/usage` → `budget.approvalMode`; `budget` is null without an org. */
export function approvalModeFromUsage(body: unknown): AiApprovalMode | null {
  if (!body || typeof body !== 'object') return null;
  const budget = (body as { budget?: unknown }).budget;
  if (!budget || typeof budget !== 'object') return null;
  return parseApprovalMode((budget as { approvalMode?: unknown }).approvalMode);
}

export interface ApprovalModeCopy {
  label: string;
  description: string;
}

const WHERE_TO_CHANGE = 'An admin can change it under Organization settings, on the AI tab, on the web.';

export function approvalModeCopy(mode: AiApprovalMode | null): ApprovalModeCopy {
  switch (mode) {
    case 'per_step':
      return {
        label: 'Approve each step',
        description:
          'Breeze asks before every action it takes. Your organization sets this. '
          + 'An admin can switch it to plan approval under Organization settings, on the AI tab, on the web, '
          + 'so a multi-step task needs one approval.',
      };
    case 'action_plan':
      return {
        label: 'Approve the plan',
        description:
          'For a multi-step task Breeze shows the whole plan first, and one approval runs its steps. '
          + `Destructive actions still ask separately. Your organization sets this. ${WHERE_TO_CHANGE}`,
      };
    case 'hybrid_plan':
      return {
        label: 'Approve the plan, with Stop',
        description:
          'For a multi-step task Breeze shows the whole plan first, and one approval runs its steps. '
          + 'You can stop a running plan at any time. Destructive actions still ask separately. '
          + `Your organization sets this. ${WHERE_TO_CHANGE}`,
      };
    case 'auto_approve':
      return {
        label: 'Auto-approve',
        description:
          'Routine actions run without asking and are logged. Destructive and remote-control actions still ask. '
          + `Your organization sets this. ${WHERE_TO_CHANGE}`,
      };
    default:
      return {
        label: 'Set by your organization',
        description:
          'Each organization chooses whether Breeze asks before every step or once per plan. '
          + WHERE_TO_CHANGE,
      };
  }
}
