import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiModelsSnapshotDto, AiOfferingDto, OfferingVerificationState } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { formatCurrency, formatNumber } from '../../../lib/i18n/format';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import OfferingDrawer from './OfferingDrawer';
import ManualModelForm from './ManualModelForm';
import { ENABLE_BLOCKER_KEYS, SURFACE_LABEL_KEYS, registryFriendly } from './surfaceLabels';

type DefaultFor = AiOfferingDto['defaultFor'];

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

const rowKey = (o: AiOfferingDto) => o.id ?? `pm-${o.platformModelId}`;

function ratePair(rates: NonNullable<AiOfferingDto['rates']>, t: TFunction<'settings'>): string {
  return t('aiModels.models.ratePair', {
    input: formatCurrency(rates.inputCentsPerM / 100),
    output: formatCurrency(rates.outputCentsPerM / 100),
  });
}

function surfaceSummary(inUse: DefaultFor, t: TFunction<'settings'>): { surfaces: string; orgCount: number } {
  const surfaces = [...new Set(inUse.map((u) => u.surface))].map((s) => t(/* i18n-dynamic */ SURFACE_LABEL_KEYS[s]));
  return { surfaces: surfaces.join(', '), orgCount: inUse.filter((u) => u.level === 'org').length };
}

interface Group { key: string; name: string; offerings: AiOfferingDto[]; /** Set for a gateway connection the admin can add models to by hand. */ manualConnectionId: string | null }

const VERIFICATION_CLASS: Record<OfferingVerificationState, string> = {
  verified: 'bg-success/10 text-success',
  unverified: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
  stale: 'bg-warning/10 text-warning',
};

function verificationLabel(v: NonNullable<AiOfferingDto['verification']>, t: TFunction<'settings'>): string {
  switch (v.state) {
    case 'verified': return t('aiModels.models.verification.verified');
    case 'unverified': return t('aiModels.models.verification.unverified');
    case 'failed': return v.summary
      ? t('aiModels.models.verification.failedWithSummary', { summary: v.summary })
      : t('aiModels.models.verification.failed');
    case 'stale': return t('aiModels.models.verification.stale');
    default: {
      const unreachable: never = v.state;
      return String(unreachable);
    }
  }
}

/** Platform first (snapshot order), then each own connection; offerings of an unknown connection trail. */
function groupOfferings(snapshot: AiModelsSnapshotDto, fallbackName: string): Group[] {
  const groups: Group[] = snapshot.connections.map((c) => ({
    key: c.id ?? 'platform',
    name: c.name,
    offerings: snapshot.offerings.filter((o) => (o.connectionId ?? null) === c.id),
    // Env-managed endpoints are read-only; so is anything not live.
    manualConnectionId: c.id !== null && c.kind === 'openai_compatible' && c.managedBy !== 'env' ? c.id : null,
  }));
  const known = new Set(snapshot.connections.map((c) => c.id));
  const stray = snapshot.offerings.filter((o) => !known.has(o.connectionId ?? null));
  if (stray.length > 0) groups.push({ key: 'other', name: fallbackName, offerings: stray, manualConnectionId: null });
  return groups.filter((g) => g.offerings.length > 0 || g.manualConnectionId !== null);
}

export default function ModelsCard({
  snapshot,
  onChanged,
}: {
  snapshot: AiModelsSnapshotDto;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ offering: AiOfferingDto; inUse: DefaultFor } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingManualTo, setAddingManualTo] = useState<string | null>(null);
  const editing = editingId ? snapshot.offerings.find((o) => o.id === editingId) ?? null : null;
  const baseFriendly = registryFriendly(t);

  const sendEnable = async (o: AiOfferingDto, enabled: boolean, force: boolean) => {
    setBusyKey(rowKey(o));
    try {
      await runAction({
        request: () => (o.id === null
          ? fetchWithAuth(`/ai/models/offerings/platform/${o.platformModelId}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) })
          : fetchWithAuth(`/ai/models/offerings/${o.id}/enabled`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(force ? { enabled, force: true } : { enabled }) })),
        // Spec §15 #1: the rate is shown at enable time.
        successMessage: enabled
          ? (o.rates
            ? t('aiModels.models.enabledAt', { name: o.displayName, rate: ratePair(o.rates, t) })
            : t('aiModels.models.enabled', { name: o.displayName }))
          : t('aiModels.models.disabled', { name: o.displayName }),
        errorFallback: t('aiModels.models.toggleFailed'),
        friendly: (code) => (code === 'offering_in_use' ? t('aiModels.models.inUseFriendly') : baseFriendly(code)),
        onUnauthorized,
      });
      setConfirm(null);
      await onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.code === 'offering_in_use') {
        // The snapshot was stale: open the same confirm from the server's own list.
        const inUse = (err.body as { details?: { inUse?: DefaultFor } } | undefined)?.details?.inUse ?? [];
        setConfirm({ offering: o, inUse });
        return;
      }
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.models.toggleFailed') });
      // other ActionErrors already toasted by runAction
    } finally {
      setBusyKey(null);
    }
  };

  const onToggle = (o: AiOfferingDto, next: boolean) => {
    if (!next && o.defaultFor.length > 0) { setConfirm({ offering: o, inUse: o.defaultFor }); return; }
    void sendEnable(o, next, false);
  };

  const groups = groupOfferings(snapshot, t('aiModels.models.otherGroup'));
  const summary = confirm ? surfaceSummary(confirm.inUse, t) : null;

  return (
    <section data-testid="ai-models-card" className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('aiModels.models.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('aiModels.models.subtitle')}</p>
      </div>

      {groups.length === 0 && <p className="text-sm text-muted-foreground">{t('aiModels.models.empty')}</p>}

      {groups.map((g) => (
        <div key={g.key} data-testid={`ai-models-group-${g.key}`} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.name}</h4>
            {g.manualConnectionId !== null && (
              <button type="button" data-testid={`ai-models-add-manual-${g.manualConnectionId}`}
                onClick={() => setAddingManualTo(g.manualConnectionId)}
                className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted">
                {t('aiModels.models.manual.add')}
              </button>
            )}
          </div>
          {g.offerings.length === 0 && <p className="text-xs text-muted-foreground">{t('aiModels.models.manual.empty')}</p>}
          {g.offerings.length > 0 && <ul className="divide-y rounded-md border">
            {g.offerings.map((o) => {
              const key = rowKey(o);
              const blocked = o.enableBlocker !== null && o.enableBlocker !== 'connection_unavailable';
              const switchDisabled = busyKey === key || (blocked && !o.enabled);
              return (
                <li key={key} data-testid={`ai-offering-row-${key}`} className="flex flex-wrap items-start justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{o.displayName}</span>
                      {o.verification && (
                        <span data-testid={`ai-model-verification-${key}`} className={`rounded-full px-2 py-0.5 text-xs ${VERIFICATION_CLASS[o.verification.state]}`}>
                          {verificationLabel(o.verification, t)}
                        </span>
                      )}
                      {o.thinkingMode === 'unknown' && o.verification === null && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('aiModels.models.unverified')}</span>
                      )}
                      {o.lifecycle === 'missing' && (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">{t('aiModels.models.lifecycle.missing')}</span>
                      )}
                      {o.lifecycle === 'retired' && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{t('aiModels.models.lifecycle.retired')}</span>
                      )}
                      {o.defaultFor.length > 0 && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          {t('aiModels.models.defaultFor', { count: o.defaultFor.length })}
                        </span>
                      )}
                    </div>
                    <div data-testid={`ai-offering-price-${key}`} className="text-xs text-muted-foreground">
                      {o.contextTokens !== null && <span>{t('aiModels.models.context', { tokens: formatNumber(o.contextTokens) })} · </span>}
                      {o.rates ? <span>{ratePair(o.rates, t)}</span> : <span>{t('aiModels.models.noPrice')}</span>}
                      {o.fastRates && <span> · {t('aiModels.models.fastRate', { rate: ratePair(o.fastRates, t) })}</span>}
                    </div>
                    {o.enableBlocker !== null && (
                      <p data-testid={`ai-offering-blocker-${key}`} className={`text-xs ${blocked ? 'text-muted-foreground' : 'text-warning'}`}>
                        {o.enableBlocker === 'unpriced' && o.verification !== null
                          ? t('aiModels.models.setPriceToEnable')
                          : t(/* i18n-dynamic */ ENABLE_BLOCKER_KEYS[o.enableBlocker])}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      data-testid={`ai-offering-edit-${key}`}
                      disabled={o.id === null}
                      title={o.id === null ? t('aiModels.models.enableFirst') : undefined}
                      onClick={() => setEditingId(o.id)}
                      className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      {t('aiModels.models.details')}
                    </button>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        role="switch"
                        data-testid={`ai-offering-enable-${key}`}
                        aria-label={t('aiModels.models.enableLabel', { name: o.displayName })}
                        checked={o.enabled}
                        disabled={switchDisabled}
                        onChange={(e) => onToggle(o, e.target.checked)}
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>}
        </div>
      ))}

      {editing && (
        <OfferingDrawer key={editing.id} offering={editing} offerings={snapshot.offerings}
          onClose={() => setEditingId(null)} onSaved={onChanged} />
      )}

      {addingManualTo !== null && (
        <ManualModelForm connectionId={addingManualTo} onClose={() => setAddingManualTo(null)} onSaved={onChanged} />
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => { if (busyKey === null) setConfirm(null); }}
        onConfirm={() => { if (confirm) void sendEnable(confirm.offering, false, true); }}
        title={t('aiModels.models.disableTitle', { name: confirm?.offering.displayName ?? '' })}
        message={t('aiModels.models.disableMessage')}
        confirmLabel={t('aiModels.models.disableAnyway')}
        confirmTestId="ai-offering-disable-confirm-submit"
        dialogTestId="ai-offering-disable-confirm"
        isLoading={busyKey !== null}
      >
        {summary && (
          <div data-testid="ai-offering-disable-confirm-surfaces" className="mt-2 space-y-1 text-sm">
            <p>{summary.surfaces}</p>
            {summary.orgCount > 0 && <p className="text-muted-foreground">{t('aiModels.models.orgOverrides', { count: summary.orgCount })}</p>}
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
