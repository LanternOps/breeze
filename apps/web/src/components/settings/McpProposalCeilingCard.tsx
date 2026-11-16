import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { MCP_UNATTENDED_PROPOSAL_CEILINGS, type McpUnattendedProposalCeiling } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import StepUpPrompt, { type ReauthTier } from './StepUpPrompt';

const OPTION_KEYS: Record<McpUnattendedProposalCeiling, string> = {
  none: 'scriptAuthoringPage.mcpCeiling.options.none',
  low: 'scriptAuthoringPage.mcpCeiling.options.low',
  medium: 'scriptAuthoringPage.mcpCeiling.options.medium',
  high: 'scriptAuthoringPage.mcpCeiling.options.high',
  critical: 'scriptAuthoringPage.mcpCeiling.options.critical',
};

/**
 * The partner's MCP unattended proposal ceiling: the highest reviewed risk a
 * principal on MCP_UNATTENDED_TIER3_PRINCIPALS may run over MCP with no human
 * approval. Saved through its own endpoint; a raise needs a step-up grant
 * bound to the new value, revealed by the server's 403 like the lane ceiling.
 */
export default function McpProposalCeilingCard({
  value,
  canManage,
  partnerId,
  reauthTier,
  mintGrant,
  revealStepUp,
  onSaved,
}: {
  value: McpUnattendedProposalCeiling;
  canManage: boolean;
  partnerId: string | null;
  reauthTier: ReauthTier | null;
  mintGrant: (resource: object, code: string) => Promise<string>;
  revealStepUp: (open: () => void) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<McpUnattendedProposalCeiling>(value);
  const [saving, setSaving] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(value), [value]);

  const usableTier = reauthTier === 'totp' || reauthTier === 'passkey';

  async function handleSave() {
    if (stepUpOpen && reauthTier === 'totp' && code.length === 0) return;
    setSaving(true);
    setError(null);
    let stepUpGrant: string | undefined;
    try {
      if (stepUpOpen && partnerId) {
        try {
          stepUpGrant = await mintGrant({ partnerId, mcpUnattendedProposalMaxRisk: draft }, code);
        } catch (err) {
          setError(err instanceof Error ? err.message : t('scriptAuthoringPage.saveFailed'));
          return;
        }
      }
      await runAction({
        request: () => fetchWithAuth('/partner/ai/script-policy/mcp-proposal-ceiling', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mcpUnattendedProposalMaxRisk: draft, ...(stepUpGrant ? { stepUpGrant } : {}) }),
        }),
        errorFallback: t('scriptAuthoringPage.saveFailed'),
        successMessage: t('scriptAuthoringPage.saved'),
        suppressErrorToast: (status, errCode) => !stepUpGrant && status === 403 && errCode === 'STEP_UP_REQUIRED',
      });
      setCode('');
      setStepUpOpen(false);
      await onSaved();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!stepUpGrant && !stepUpOpen && err instanceof ActionError && err.status === 403 && err.code === 'STEP_UP_REQUIRED') {
        await revealStepUp(() => setStepUpOpen(true));
        return;
      }
      setError(err instanceof ActionError ? err.message : t('scriptAuthoringPage.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4" data-testid="script-mcp-ceiling-card">
      <div>
        <h2 className="text-lg font-semibold">{t('scriptAuthoringPage.mcpCeiling.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('scriptAuthoringPage.mcpCeiling.description')}</p>
      </div>
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="script-mcp-ceiling-error">
          {error}
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {t('scriptAuthoringPage.mcpCeiling.label')}
        <select
          data-testid="script-mcp-ceiling-select"
          value={draft}
          disabled={!canManage || saving}
          onChange={(e) => setDraft(e.target.value as McpUnattendedProposalCeiling)}
          className="w-full max-w-xs rounded-md border bg-background px-3 py-2"
        >
          {MCP_UNATTENDED_PROPOSAL_CEILINGS.map((option) => (
            <option key={option} value={option}>{t(/* i18n-dynamic */ OPTION_KEYS[option])}</option>
          ))}
        </select>
      </label>
      {canManage && stepUpOpen && usableTier && (
        <div className="space-y-2 rounded-md border p-3" data-testid="script-mcp-ceiling-stepup">
          <p className="text-sm font-medium">{t('scriptAuthoringPage.stepUp.title')}</p>
          <p className="text-xs text-muted-foreground">{t('scriptAuthoringPage.mcpCeiling.stepUpBody')}</p>
          <StepUpPrompt tier={reauthTier as ReauthTier} reauthValue={code} onChange={setCode} disabled={saving} />
        </div>
      )}
      {canManage && (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="script-mcp-ceiling-save"
            onClick={() => void handleSave()}
            disabled={saving || draft === value}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('scriptAuthoringPage.save')}
          </button>
        </div>
      )}
    </div>
  );
}
