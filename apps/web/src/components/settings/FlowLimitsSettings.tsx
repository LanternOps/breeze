import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { FLOW_LIMIT_KEYS, type FlowLimitKey, type FlowLimitsUpdate, type FlowLimitsViewDto } from '@breeze/shared';
import { ActionError } from '@/lib/runAction';
import { useFlowsGate } from '../../stores/featuresStore';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { getFlowLimits, saveFlowLimits } from '../flows/api';

type Drafts = Record<FlowLimitKey, string>;
type FieldErrors = Partial<Record<FlowLimitKey, string>>;

const PARTNER = '__partner__';

function draftsFrom(view: FlowLimitsViewDto): Drafts {
  const out = {} as Drafts;
  for (const key of FLOW_LIMIT_KEYS) out[key] = view.stored[key] === null ? '' : String(view.stored[key]);
  return out;
}

/**
 * Flow limits (Tool Catalog W05 #5220, plan Decision 15 / Task D3) — the one
 * home of the monthly run caps and the per-run AI token limit.
 *
 * Settings rule 3 exception, stated in the UI: an organization may only LOWER
 * the partner's value. Blank = inherit, and the field always shows the
 * inherited value and its source (rule 4). Form screen ⇒ page Save (rule 7).
 * The server re-checks the ceiling (`limit_above_partner_ceiling`).
 */
export default function FlowLimitsSettings() {
  const { t, i18n } = useTranslation('flows');
  const { enabled } = useFlowsGate();
  const orgs = useOrgStore((s) => s.organizations) as Array<{ id: string; name: string }>;
  const [partnerLevel, setPartnerLevel] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string>(PARTNER);
  const [view, setView] = useState<FlowLimitsViewDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const fmt = (n: number) => n.toLocaleString(i18n.language || undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoadFailed(false);
    setView(null);
    getFlowLimits(selected === PARTNER ? undefined : selected)
      .then((v) => {
        if (cancelled) return;
        // The server decides the caller's level: a partner caller's first read
        // is the partner default; an org caller always gets its own org.
        if (partnerLevel === null) setPartnerLevel(v.level === 'partner');
        setView(v);
        setDrafts(draftsFrom(v));
        setServerErrors({});
      })
      .catch((err: unknown) => {
        console.error('[FlowLimitsSettings] could not load flow limits', err);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // partnerLevel is set once from the first answer; it must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selected]);

  const clientErrors = useMemo<FieldErrors>(() => {
    if (!view || !drafts) return {};
    const out: FieldErrors = {};
    for (const key of FLOW_LIMIT_KEYS) {
      const raw = drafts[key].trim();
      if (raw === '') continue;
      const n = Number(raw);
      // Only an edited field is checked: a stored value above a since-lowered
      // ceiling is shown as "does not apply", not as an error blocking Save.
      if (n === view.stored[key]) continue;
      const max = view.level === 'org' && view.limits.partnerCeiling ? view.limits.partnerCeiling[key] : view.ceilings[key];
      if (!Number.isInteger(n) || n < 1 || n > view.ceilings[key]) out[key] = t('limits.range', { max: fmt(view.ceilings[key]) });
      else if (n > max) out[key] = t('limits.aboveCeilingError', { value: fmt(max) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, drafts, t]);

  if (!enabled) return null;

  const changes = (): FlowLimitsUpdate['limits'] => {
    const out: FlowLimitsUpdate['limits'] = {};
    if (!view || !drafts) return out;
    for (const key of FLOW_LIMIT_KEYS) {
      const raw = drafts[key].trim();
      const next = raw === '' ? null : Number(raw);
      if (next !== view.stored[key]) out[key] = next;
    }
    return out;
  };

  const save = async () => {
    if (!view || saving) return;
    const limits = changes();
    if (Object.keys(limits).length === 0) return;
    setSaving(true);
    setServerErrors({});
    try {
      const body: FlowLimitsUpdate = view.level === 'org' && view.orgId ? { orgId: view.orgId, limits } : { limits };
      const next = await saveFlowLimits(body);
      setView(next);
      setDrafts(draftsFrom(next));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (err instanceof ActionError) {
        // limit_above_partner_ceiling is not toasted: show it on its field.
        const b = err.body as { error?: string; field?: FlowLimitKey; ceiling?: number } | undefined;
        if (b?.error === 'limit_above_partner_ceiling' && b.field && typeof b.ceiling === 'number') {
          setServerErrors({ [b.field]: t('limits.aboveCeilingError', { value: fmt(b.ceiling) }) });
        }
      } else {
        showToast({ type: 'error', message: t('limits.saveFailed') }); // ActionError already toasted
      }
    } finally {
      setSaving(false);
    }
  };

  const errors: FieldErrors = { ...clientErrors, ...serverErrors };
  const hasErrors = Object.values(errors).some(Boolean);
  const dirty = Object.keys(changes()).length > 0;

  return (
    <div className="max-w-3xl space-y-6 p-4" data-testid="flow-limits">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('limits.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('limits.subtitle')}</p>
      </header>

      {partnerLevel && (
        <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
          <span className="font-medium">{t('limits.level.label')}</span>
          <select
            className="rounded border bg-background px-2 py-1.5"
            value={selected}
            onChange={(e) => {
              // Drop the previous level's form at once, so nothing is typed into it.
              setView(null);
              setDrafts(null);
              setSelected(e.target.value);
            }}
            data-testid="flow-limits-level"
          >
            <option value={PARTNER}>{t('limits.level.partner')}</option>
            {(orgs ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}

      {loadFailed && <p className="text-sm text-destructive" data-testid="flow-limits-error">{t('limits.loadFailed')}</p>}

      {view && drafts && (
        <form
          className="space-y-5"
          // Validation is ours: a stored value above a since-lowered ceiling
          // would otherwise make the browser refuse to submit the whole form.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!view.canManage && (
            <p className="text-sm text-muted-foreground" data-testid="flow-limits-readonly">
              {view.level === 'org' && partnerLevel === false ? t('limits.orgScopeReadOnly') : t('limits.readOnly')}
            </p>
          )}
          {FLOW_LIMIT_KEYS.map((key) => {
            const stored = view.stored[key];
            const ceiling = view.limits.partnerCeiling?.[key];
            const inheritedValue = view.level === 'org' ? (ceiling ?? view.defaults[key]) : view.defaults[key];
            // An org inherits the partner's effective value; the org view does not
            // carry the partner's stored value, so a partner value equal to the
            // platform default reads as the default (same number either way).
            const inheritedSource = view.level === 'org' && inheritedValue !== view.defaults[key] ? 'partner' : 'default';
            const aboveCeiling = view.level === 'org' && stored !== null && ceiling !== undefined && stored > ceiling;
            const inputId = `flow-limit-${key}`;
            return (
              <div key={key} className="space-y-1">
                <label htmlFor={inputId} className="text-sm font-medium">{t(/* i18n-dynamic */ `limits.fields.${key}.label`)}</label>
                <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `limits.fields.${key}.help`)}</p>
                <input
                  id={inputId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={view.level === 'org' && ceiling !== undefined ? ceiling : view.ceilings[key]}
                  className="w-48 rounded border bg-background px-2 py-1.5 text-sm"
                  placeholder={t('limits.placeholder')}
                  disabled={!view.canManage || saving}
                  value={drafts[key]}
                  onChange={(e) => {
                    setDrafts({ ...drafts, [key]: e.target.value });
                    setServerErrors((prev) => {
                      const { [key]: _dropped, ...rest } = prev;
                      return rest;
                    });
                  }}
                  aria-invalid={errors[key] ? true : undefined}
                  data-testid={`flow-limit-input-${key}`}
                />
                {drafts[key].trim() === '' && (
                  <p className="text-xs text-muted-foreground" data-testid={`flow-limit-inherited-${key}`}>
                    {t('limits.inherited', {
                      value: fmt(inheritedValue),
                      source: t(/* i18n-dynamic */ `limits.source.${inheritedSource}`),
                    })}
                  </p>
                )}
                {view.level === 'org' && ceiling !== undefined && (
                  <p className="text-xs text-muted-foreground" data-testid={`flow-limit-ceiling-${key}`}>
                    {t('limits.ceilingNote', { value: fmt(ceiling) })}
                  </p>
                )}
                {aboveCeiling && (
                  <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`flow-limit-above-${key}`}>
                    {t('limits.aboveCeiling', { value: fmt(stored) })}
                  </p>
                )}
                {errors[key] && (
                  <p className="text-xs text-destructive" data-testid={`flow-limit-error-${key}`}>{errors[key]}</p>
                )}
              </div>
            );
          })}
          {view.canManage && (
            <button
              type="submit"
              className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              disabled={saving || hasErrors || !dirty}
              data-testid="flow-limits-save"
            >
              {saving ? t('limits.saving') : t('limits.save')}
            </button>
          )}
        </form>
      )}
    </div>
  );
}
