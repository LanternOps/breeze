import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  alertLifecycleDefaultsSchema,
  type AlertLifecycleDefaultsResponse,
  type LifecycleSource,
  type PartialLifecycle,
  type RearmMode,
} from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgScope } from '@/hooks/useOrgScope';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '@/lib/runAction';
import InheritedField from '../shared/InheritedField';
import { autoResolveLabel, fetchLifecycleDefaults, rearmLabel, sourceLabel } from './lifecycleDefaults';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const FIELD_CLASS = 'mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50';

type Draft = {
  autoResolve: '' | 'true' | 'false';
  rearmMode: '' | RearmMode;
  rearmDelayMinutes: string;
  cooldownMinutes: string;
};

function toDraft(defaults: AlertLifecycleDefaultsResponse, orgId: string | null): Draft {
  const level: PartialLifecycle = orgId ? (defaults.org ?? {}) : defaults.partner;
  return {
    autoResolve: level.autoResolve === null || level.autoResolve === undefined ? '' : level.autoResolve ? 'true' : 'false',
    rearmMode: level.rearmMode ?? '',
    rearmDelayMinutes: level.rearmDelayMinutes === null || level.rearmDelayMinutes === undefined ? '' : String(level.rearmDelayMinutes),
    cooldownMinutes: level.cooldownMinutes === null || level.cooldownMinutes === undefined ? '' : String(level.cooldownMinutes),
  };
}

function toPayload(draft: Draft, orgId: string | null): Record<string, unknown> {
  const values = {
    autoResolve: draft.autoResolve === '' ? null : draft.autoResolve === 'true',
    rearmMode: draft.rearmMode === '' ? null : draft.rearmMode,
    // The delay belongs to the mode: anything but after_delay sends null, whatever was typed.
    rearmDelayMinutes: draft.rearmMode === 'after_delay' ? numberOrNull(draft.rearmDelayMinutes) : null,
    cooldownMinutes: numberOrNull(draft.cooldownMinutes),
  };
  return orgId ? { scope: 'organization', orgId, ...values } : { scope: 'partner', ...values };
}

// `??`-safe: 0 is a real cooldown, only blank means inherit.
function numberOrNull(text: string): number | null {
  return text.trim() === '' ? null : Number(text);
}

function OverrideCount({ count }: { count: number }) {
  const { t } = useTranslation('monitoring');
  if (count <= 0) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:lifecycleDefaults.overrideCount', { count })}</p>;
}

/**
 * Alerts → Monitors "Lifecycle defaults" (settings rules 3, 4, 7): the partner
 * default with All organizations selected, that org's override with an org
 * selected. Form card with one Save. Blank = inherit, and each field shows the
 * inherited value and where it comes from. The selects carry both in their
 * Inherit option because InheritedField is text/number only.
 */
export default function LifecycleDefaultsCard() {
  const { t } = useTranslation(['monitoring', 'common']);
  const orgScope = useOrgScope();
  const orgId = orgScope.scope === 'org' ? orgScope.orgId : null;
  // A partner with no orgs yet still has a partner default to set.
  const isPartnerLevel = orgScope.scope === 'all' || orgScope.status === 'empty';
  const contextReady = orgId !== null || isPartnerLevel;
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide ?? true);
  const readOnly = isPartnerLevel && !canManagePartnerWide;

  // Keyed by level so switching org can never show or save the previous org's values.
  const levelKey = orgId ?? 'partner';
  const [loaded, setLoaded] = useState<{ levelKey: string; defaults: AlertLifecycleDefaultsResponse } | null>(null);
  const defaults = loaded?.levelKey === levelKey ? loaded.defaults : null;
  const currentLevelKey = useRef(levelKey);
  currentLevelKey.current = levelKey;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoadFailed(false);
    try {
      const data = await fetchLifecycleDefaults(orgId);
      if (seq !== requestSeq.current) return;
      setLoaded({ levelKey, defaults: data });
      setDraft(toDraft(data, orgId));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.warn('Could not load the alert lifecycle defaults (%s)', err instanceof Error ? err.message : 'unknown error');
      setLoadFailed(true);
    }
  }, [levelKey, orgId]);

  useEffect(() => {
    if (contextReady) void load();
  }, [contextReady, load]);

  if (orgScope.status === 'error') return null;

  const showForm = defaults !== null && draft !== null;

  const payload = showForm ? toPayload(draft, orgId) : null;
  const parsed = payload ? alertLifecycleDefaultsSchema.safeParse(payload) : null;
  const invalidFields = new Set(parsed && !parsed.success ? parsed.error.issues.map((issue) => String(issue.path[0])) : []);
  const isDirty = showForm && JSON.stringify(payload) !== JSON.stringify(toPayload(toDraft(defaults, orgId), orgId));
  const canSave = isDirty && !!parsed?.success && !saving;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || !parsed?.success) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/alerts/lifecycle-defaults', {
          method: 'PUT',
          body: JSON.stringify(parsed.data),
          skipOrgIdInjection: true,
        }),
        errorFallback: t('monitoring:lifecycleDefaults.errors.save'),
        successMessage: t('monitoring:lifecycleDefaults.saved'),
        onUnauthorized: UNAUTHORIZED,
      });
      // Inputs stay disabled through the reload so it cannot overwrite a newer edit.
      // If the org changed mid-save, the effect is already loading the new level, and
      // this closure's load would supersede that request with the old level's data.
      if (currentLevelKey.current === levelKey) await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:lifecycleDefaults.errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const inheritedSource = (source: LifecycleSource) => sourceLabel(t, source === 'builtin' ? 'builtin' : 'partner');
  const disabled = readOnly || saving;

  return (
    <section className="rounded-lg border bg-card p-4 shadow-xs" data-testid="lifecycle-defaults-card">
      <h2 className="text-sm font-semibold">{t('monitoring:lifecycleDefaults.title')}</h2>
      {/* Post-load only: the org context can differ between the server render and hydration. */}
      {showForm && (
        <p className="mt-1 text-xs text-muted-foreground">
          {orgId ? t('monitoring:lifecycleDefaults.descriptionOrg') : t('monitoring:lifecycleDefaults.descriptionPartner')}
        </p>
      )}

      {!showForm && !loadFailed && <div className="mt-3 h-20 animate-pulse rounded-md bg-muted" />}

      {loadFailed && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('monitoring:lifecycleDefaults.errors.load')}{' '}
          <button type="button" className="underline" onClick={() => void load()}>{t('common:actions.retry')}</button>
        </div>
      )}

      {showForm && (
        <form onSubmit={(event) => void onSubmit(event)} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium" htmlFor="lifecycle-auto-resolve">{t('monitoring:editor.fields.autoResolve')}</label>
              <select
                id="lifecycle-auto-resolve"
                data-testid="lifecycle-auto-resolve"
                className={FIELD_CLASS}
                value={draft.autoResolve}
                disabled={disabled}
                onChange={(e) => update({ autoResolve: e.target.value as Draft['autoResolve'] })}
              >
                {orgId && (
                  <option value="">
                    {t('monitoring:lifecycle.inheritOption', {
                      value: autoResolveLabel(t, defaults.partner.autoResolve),
                      source: inheritedSource(defaults.sources.autoResolve),
                    })}
                  </option>
                )}
                <option value="true">{t('monitoring:lifecycle.autoResolveOn')}</option>
                <option value="false">{t('monitoring:lifecycle.autoResolveOff')}</option>
              </select>
              {orgId && draft.autoResolve !== '' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('common:inheritedField.overridingWithValue', {
                    source: inheritedSource(defaults.sources.autoResolve),
                    value: autoResolveLabel(t, defaults.partner.autoResolve),
                  })}
                </p>
              )}
              <OverrideCount count={defaults.monitorOverrideCounts.autoResolve} />
            </div>

            <div>
              <label className="text-sm font-medium" htmlFor="lifecycle-rearm-mode">{t('monitoring:lifecycle.rearmLabel')}</label>
              <select
                id="lifecycle-rearm-mode"
                data-testid="lifecycle-rearm-mode"
                className={FIELD_CLASS}
                value={draft.rearmMode}
                disabled={disabled}
                onChange={(e) => update({ rearmMode: e.target.value as Draft['rearmMode'] })}
              >
                {orgId && (
                  <option value="">
                    {t('monitoring:lifecycle.inheritOption', {
                      value: rearmLabel(t, defaults.partner),
                      source: inheritedSource(defaults.sources.rearmMode),
                    })}
                  </option>
                )}
                <option value="new_evidence">{t('monitoring:lifecycle.rearmNewEvidence')}</option>
                <option value="after_delay">{t('monitoring:lifecycle.rearmAfterDelay')}</option>
              </select>
              {orgId && draft.rearmMode !== '' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('common:inheritedField.overridingWithValue', {
                    source: inheritedSource(defaults.sources.rearmMode),
                    value: rearmLabel(t, defaults.partner),
                  })}
                </p>
              )}
              <OverrideCount count={defaults.monitorOverrideCounts.rearmMode} />
              {draft.rearmMode === 'after_delay' && (
                <div className="mt-2">
                  <label className="text-sm font-medium" htmlFor="lifecycle-rearm-delay">{t('monitoring:lifecycle.rearmDelayLabel')}</label>
                  <input
                    id="lifecycle-rearm-delay"
                    data-testid="lifecycle-rearm-delay"
                    type="number"
                    min={1}
                    max={1440}
                    step="1"
                    className={FIELD_CLASS}
                    value={draft.rearmDelayMinutes}
                    disabled={disabled}
                    aria-invalid={invalidFields.has('rearmDelayMinutes') || undefined}
                    onChange={(e) => update({ rearmDelayMinutes: e.target.value })}
                  />
                  {invalidFields.has('rearmDelayMinutes') && (
                    <p role="alert" className="mt-1 text-xs text-destructive">{t('monitoring:lifecycle.errors.rearmDelay')}</p>
                  )}
                  <OverrideCount count={defaults.monitorOverrideCounts.rearmDelayMinutes} />
                </div>
              )}
            </div>

            <div>
              {orgId ? (
                <InheritedField
                  id="lifecycle-cooldown"
                  data-testid="lifecycle-cooldown"
                  label={t('monitoring:editor.fields.cooldownMinutes')}
                  type="number"
                  min={0}
                  max={1440}
                  step="1"
                  value={draft.cooldownMinutes}
                  onChange={(cooldownMinutes) => update({ cooldownMinutes })}
                  disabled={disabled}
                  inheritedValue={String(defaults.partner.cooldownMinutes)}
                  inheritedSource={inheritedSource(defaults.sources.cooldownMinutes)}
                  ariaInvalid={invalidFields.has('cooldownMinutes')}
                />
              ) : (
                <>
                  <label className="text-sm font-medium" htmlFor="lifecycle-cooldown">{t('monitoring:editor.fields.cooldownMinutes')}</label>
                  <input
                    id="lifecycle-cooldown"
                    data-testid="lifecycle-cooldown"
                    type="number"
                    min={0}
                    max={1440}
                    step="1"
                    className={FIELD_CLASS}
                    value={draft.cooldownMinutes}
                    disabled={disabled}
                    aria-invalid={invalidFields.has('cooldownMinutes') || undefined}
                    onChange={(e) => update({ cooldownMinutes: e.target.value })}
                  />
                </>
              )}
              {invalidFields.has('cooldownMinutes') && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {orgId ? t('monitoring:lifecycle.errors.cooldownOrInherit') : t('monitoring:lifecycle.errors.cooldown')}
                </p>
              )}
              <OverrideCount count={defaults.monitorOverrideCounts.cooldownMinutes} />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t('monitoring:lifecycle.rearmHelp')}</p>

          {readOnly ? (
            <p className="text-xs text-muted-foreground">{t('monitoring:lifecycleDefaults.readOnly')}</p>
          ) : (
            <div className="flex justify-end">
              <button
                type="submit"
                data-testid="lifecycle-save"
                disabled={!canSave}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? t('monitoring:editor.actions.saving') : t('monitoring:editor.actions.save')}
              </button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
