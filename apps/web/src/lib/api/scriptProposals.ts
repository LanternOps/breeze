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
