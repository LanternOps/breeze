// Mirrors lib/api/scripts.ts: there is no generic apiFetch/apiClient in this
// app. Reads go straight through fetchWithAuth; MUTATIONS are wrapped in
// runAction here so no caller can accidentally fire a silent one (CLAUDE.md
// "Web Mutation Handlers — runAction").
import type { ScriptProposalDetailDto } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function fetchScriptProposal(
  id: string,
  signal?: AbortSignal,
): Promise<ScriptProposalDetailDto> {
  const res = await fetchWithAuth(`/ai/script-proposals/${id}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load proposal (${res.status})`);
  }
  return (await res.json()) as ScriptProposalDetailDto;
}

export async function requestScriptProposalChanges(id: string, note: string): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/ai/script-proposals/${id}/request-changes`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ note }),
      }),
    errorFallback: i18n.t('ai:scriptProposal.requestChanges'),
    successMessage: i18n.t('ai:scriptProposal.sendBack'),
  });
}

export async function promoteScriptProposal(
  id: string,
  input: { name: string; description?: string; ownerScope: 'organization' | 'partner' },
): Promise<{ scriptId: string; versionId: string }> {
  return runAction<{ scriptId: string; versionId: string }>({
    request: () =>
      fetchWithAuth(`/ai/script-proposals/${id}/promote`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }),
    errorFallback: i18n.t('ai:scriptProposal.saveToLibrary'),
    successMessage: i18n.t('ai:scriptProposal.saveToLibrary'),
  });
}

/** #10954: API refusals of a review override, in the viewer's language. */
function overrideErrorMessage(code: string): string | undefined {
  const key: Record<string, string> = {
    proposal_expired: 'ai:scriptProposal.overrideErrorExpired',
    proposal_not_review_failed: 'ai:scriptProposal.overrideErrorState',
    not_sole_approver: 'ai:scriptProposal.overrideErrorNotSoleApprover',
    step_up_required: 'ai:scriptProposal.overrideErrorStepUp',
    no_device_dispatched: 'ai:scriptProposal.overrideErrorNoDevice',
    policy_denied: 'ai:scriptProposal.overrideErrorPolicy',
    strict_acknowledgement_incomplete: 'ai:scriptProposal.overrideErrorStrict',
    strict_acknowledgement_not_permitted: 'ai:scriptProposal.overrideErrorStrict',
  };
  return key[code] ? i18n.t(/* i18n-dynamic */ key[code]) : undefined;
}

export interface ScriptProposalOverrideRunResult {
  status: 'executed';
  results: Array<
    | { deviceId: string; ok: true; executionId?: string; commandId?: string }
    | { deviceId: string; ok: false; error: string }
  >;
}

/** #10954: a person signs a `review_failed` proposal and runs it on its target devices. */
export async function overrideRunScriptProposal(
  id: string,
  acknowledgedPatterns: string[],
): Promise<ScriptProposalOverrideRunResult> {
  return runAction<ScriptProposalOverrideRunResult>({
    request: () =>
      fetchWithAuth(`/ai/script-proposals/${id}/override-run`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ confirmNoPassingReview: true, acknowledgedPatterns }),
      }),
    errorFallback: i18n.t('ai:scriptProposal.overrideRun'),
    successMessage: i18n.t('ai:scriptProposal.overrideRunSuccess'),
    friendly: overrideErrorMessage,
  });
}

/** #10954: a person signs a `review_failed` proposal into the script library. */
export async function overrideSaveScriptProposal(
  id: string,
  input: { name: string; description?: string; ownerScope: 'organization' | 'partner'; acknowledgedPatterns: string[] },
): Promise<{ scriptId: string; versionId: string }> {
  return runAction<{ scriptId: string; versionId: string }>({
    request: () =>
      fetchWithAuth(`/ai/script-proposals/${id}/override-promote`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...input, confirmNoPassingReview: true }),
      }),
    errorFallback: i18n.t('ai:scriptProposal.overrideSave'),
    successMessage: i18n.t('ai:scriptProposal.saveToLibrary'),
    friendly: overrideErrorMessage,
  });
}
