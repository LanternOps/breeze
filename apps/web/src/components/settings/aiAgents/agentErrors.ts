import { ActionError } from '@/lib/runAction';

/**
 * Task 13 (#5051 review) — the save-error mapping shared by `AiAgentForm.tsx`
 * (the edit drawer, PATCH) and `AgentCreateFlow.tsx` (the guided create flow,
 * POST). The two used to carry byte-identical copies with a comment arguing
 * they should stay separate because "the two forms build DIFFERENT bodies" —
 * true of the save request, not of how a 422 from either one is read back
 * into operator-facing copy, so this is the one map both import.
 */

/** Minimal shape of react-i18next's `t` this module needs — kept local, same
 *  convention as `PolicyKeysCheckboxes.tsx`'s `TranslateFn`. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Machine token -> operator-facing sentence. The API answers a failed save
 * with a `code`, and `runAction`'s `friendly` hook is keyed on it; without
 * this the toast shows the raw token verbatim, e.g. "agent_kind_exists:
 * triage".
 */
export const AGENT_ERROR_COPY: Record<string, ((t: TranslateFn) => string) | undefined> = {
  agent_kind_exists: (t) => t('settings:aiAgentsPage.errors.kindExists'),
  mode_not_supported: (t) => t('settings:aiAgentsPage.errors.modeNotSupported'),
  // The server's 422 (Task 6, #3826) is the authoritative gate — the
  // structured `missing[]` it carries is rendered as issues by
  // `agentSaveIssuesFromError` below, this is just the toast fallback so the
  // raw machine token never reaches the user.
  act_prerequisites_not_met: (t) => t('settings:aiAgentsPage.errors.actPrerequisitesNotMet'),
  // Wave 5 Part B (#3827): the server's 422 (agentService.ts's
  // InvalidSupervisedActionKeysError) carries a structured `rejected[]` —
  // this is just the toast fallback; the per-key detail is rendered by
  // `agentSaveIssuesFromError` below.
  invalid_supervised_action_keys: (t) => t('settings:aiAgentsPage.errors.invalidSupervisedActionKeys'),
  // #5049: the server's 422 (agentService.ts's SupervisedKeysGrantOnlyError)
  // carries the identical `rejected[]` shape as invalid_supervised_action_keys
  // above — mapped as the identical toast fallback.
  supervised_keys_grant_only: (t) => t('settings:aiAgentsPage.errors.invalidSupervisedActionKeys'),
};

/**
 * `missing[]` entries from the server's `act_prerequisites_not_met` 422
 * (Task 6, #3826 — `ActPrerequisitesNotMetError`). Mapped to translated,
 * actionable copy so the operator sees what to fix rather than a machine
 * token.
 */
const ACT_PREREQUISITE_COPY: Record<string, (t: TranslateFn, ctx: AgentSaveIssueContext) => string> = {
  // `recipient` covers two different situations the server folds into one
  // token (recipients.ts `hasResolvableAgentRecipient`): nothing selected at
  // all, or roles selected that have no ACTIVE member to notify. Telling an
  // operator who just ticked a role to "add a recipient" sent them in
  // circles (#5048 QA) — the caller says which case it is.
  recipient: (t, ctx) =>
    ctx.recipientsSelected
      ? t('settings:aiAgentsPage.errors.actRecipientsUnreachable')
      : t('settings:aiAgentsPage.errors.actMissingRecipient'),
  act_eligible_tool: (t) => t('settings:aiAgentsPage.errors.actMissingTool'),
};

export interface AgentSaveIssueContext {
  /** The draft that was saved carried at least one recipient role/user. */
  recipientsSelected?: boolean;
}

/**
 * The structured per-field issues a save's 422 carries, for the two shapes
 * the API returns them in — `null` when `err` is neither, in which case the
 * caller's generic toast (via `AGENT_ERROR_COPY` and `handleActionError`)
 * already covers it and there is nothing further to set as an issue.
 */
export function agentSaveIssuesFromError(
  err: unknown,
  t: TranslateFn,
  ctx: AgentSaveIssueContext = {},
): string[] | null {
  if (!(err instanceof ActionError)) return null;

  if (err.code === 'act_prerequisites_not_met') {
    const body = err.body as { missing?: unknown } | undefined;
    const missing = Array.isArray(body?.missing)
      ? body.missing.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return missing.map((entry) => ACT_PREREQUISITE_COPY[entry]?.(t, ctx) ?? entry);
  }

  // Wave 5 Part B (#3827) / #5049: both codes carry the identical
  // `rejected[]` shape naming exactly which keys failed and why.
  if (err.code === 'invalid_supervised_action_keys' || err.code === 'supervised_keys_grant_only') {
    const body = err.body as { rejected?: unknown } | undefined;
    const rejected = Array.isArray(body?.rejected)
      ? body.rejected.filter(
          (entry): entry is { key: string; reason: string } =>
            typeof entry === 'object'
            && entry !== null
            && typeof (entry as { key?: unknown }).key === 'string'
            && typeof (entry as { reason?: unknown }).reason === 'string',
        )
      : [];
    return rejected.map((entry) =>
      t('settings:aiAgentsPage.errors.supervisedKeyRejected', { key: entry.key, reason: entry.reason }));
  }

  return null;
}
