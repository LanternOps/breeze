import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentPreviewDto } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import AgentSummaryCard from '../AgentSummaryCard';
import { buildAgentSaveBody, type Draft } from '../agentDraft';
import type { RoleOption } from '../agentFields';

/** Debounced re-fetch delay for a draft change while this step is mounted —
 *  spec §4.6 step 4: "on entry (and whenever the draft changes while on this
 *  step, debounced 300ms) POST /ai/agents/preview". A uniform debounce (the
 *  entry fetch waits the same 300ms) keeps this effect a single small block
 *  instead of a first-render special case, and 300ms is imperceptible for a
 *  review step no one is racing to see. */
const PREVIEW_DEBOUNCE_MS = 300;

export interface ReviewStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  orgId: string | null;
  orgName: string | null;
  /** The same GET /roles list Safety rendered, so the card can name the
   *  chosen approver roles instead of only counting them (#5048 QA). */
  roles: RoleOption[];
  onEdit: (section: 'purpose' | 'does' | 'safety') => void;
}

/**
 * Step 4 of the guided create flow (spec §4.6): the server-evaluated review
 * card. Posts the SAME body `buildAgentSaveBody` would send to `POST
 * /ai/agents` to `POST /ai/agents/preview` instead, so the card is evaluated
 * through the exact guardrail/catalog helpers the run loop uses and can never
 * drift from what Create will actually enforce. A preview failure never
 * blocks Create — the footer's Create button lives in `AgentCreateFlow.tsx`
 * and does not depend on this component's fetch succeeding.
 */
export default function ReviewStep({ draft, patch, orgId, orgName, roles, onEdit }: ReviewStepProps) {
  const { t } = useTranslation('settings');
  const recipientRoleNames = useMemo(() => new Map(roles.map((role) => [role.id, role.name])), [roles]);
  const [preview, setPreview] = useState<AgentPreviewDto | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const body = buildAgentSaveBody(draft, { isCreate: true, orgId });
          const response = await fetchWithAuth('/ai/agents/preview', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`POST /ai/agents/preview ${response.status}`);
          const json = (await response.json()) as { data?: AgentPreviewDto };
          if (cancelled) return;
          if (json.data) {
            setPreview(json.data);
            setPreviewError(false);
          } else {
            setPreviewError(true);
          }
        } catch (err) {
          console.error('[ReviewStep] could not load the agent preview', err);
          if (!cancelled) setPreviewError(true);
        } finally {
          if (!cancelled) setPreviewLoading(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Re-run on every draft change while this step is mounted — JSON.stringify
    // is used inside the effect rather than a manual field-by-field dependency
    // list, since the request body IS the draft, projected.
  }, [JSON.stringify(draft), orgId]);

  return (
    <div className="space-y-3">
      {previewError && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="agent-create-flow-preview-error"
        >
          {t('aiAgentsPage.flow.previewFailed')}
        </p>
      )}
      {previewLoading && !preview && !previewError && (
        <p className="text-sm text-muted-foreground" data-testid="agent-create-flow-preview-loading">
          {t('aiAgentsPage.flow.previewLoading')}
        </p>
      )}
      {preview && (
        <AgentSummaryCard
          preview={preview}
          name={draft.name}
          orgName={orgName}
          enabled={draft.enabled}
          recipientRoleNames={recipientRoleNames}
          onEdit={onEdit}
        />
      )}

      <label className="flex items-center gap-2 text-sm" data-testid="agent-create-flow-start-enabled-field">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          data-testid="agent-create-flow-start-enabled"
        />
        <span className="font-medium">{t('aiAgentsPage.flow.startEnabled')}</span>
      </label>
      <p className="pl-6 text-xs text-muted-foreground">{t('aiAgentsPage.flow.startEnabledHint')}</p>
    </div>
  );
}
