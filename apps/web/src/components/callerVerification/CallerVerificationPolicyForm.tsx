import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { useAuthStore } from '@/stores/auth';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { getPolicy, putPolicy, type Owner, type PolicyDraft, type PolicyResponse, type PolicyValues } from '@/lib/api/callerVerification';

/** [min, max, tightening direction] — mirrors the shared validator and the server resolver. */
const NUMERIC = {
  requiredTierResetPassword: [0, 3, 'max'], requiredTierDisableUser: [0, 3, 'max'],
  verificationTtlMinutes: [5, 240, 'min'], workstationTimeoutSeconds: [30, 300, 'min'],
  destinationMinAgeDays: [0, 90, 'max'], maxAttemptsPerHour: [1, 100, 'min'], coolingOffHours: [1, 720, 'max'],
} as const;
/** 'or' = an org can only turn it on; 'and' = an org can only turn it off. */
const BOOLEANS = { requireAttestedDestination: 'or', requireTicket: 'or', allowCrossTechnicianUse: 'and', allowAdministrativeDisable: 'and' } as const;
const SETS = {
  allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'],
  disableUserAuthorizerRoles: ['billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal'],
} as const;
const KEYS = [...Object.keys(NUMERIC), ...Object.keys(BOOLEANS), ...Object.keys(SETS)] as (keyof PolicyValues)[];

export function inheritedDraft(): PolicyDraft {
  return Object.fromEntries(KEYS.map((k) => [k, null])) as PolicyDraft;
}
/** Picks only policy fields: the stored row carries server columns the strict PUT schema rejects. */
function draftFrom(row: PolicyResponse['row']): PolicyDraft {
  return Object.fromEntries(KEYS.map((k) => [k, row?.[k] ?? null])) as PolicyDraft;
}

type Props = { owner: Owner; readOnly?: boolean };

/**
 * Caller verification policy editor. Partner owner = baseline for every org;
 * organization owner = tighten-only override over the partner baseline (the
 * server ignores any looser value and reports it in `effective.ignored`).
 * Owner scope is fixed by the mounting page and never sent in the body.
 */
export function CallerVerificationPolicyForm(props: Props) {
  if (!useCallerVerificationEnabled()) return null;
  return <LoadedPolicy key={props.owner.ownerScope === 'partner' ? 'partner' : props.owner.orgId} {...props} />;
}

/**
 * Partner baseline mount. Partner-wide writes need full partner org access
 * (`canManagePartnerWidePolicies` on the server, which enforces it); the UI
 * mirrors SsoProvidersPage and goes read-only only when the session says no.
 */
export function PartnerCallerVerificationPolicy() {
  if (!useCallerVerificationEnabled()) return null;
  return <PartnerPolicyGate />;
}

function PartnerPolicyGate() {
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  return <LoadedPolicy key="partner" owner={{ ownerScope: 'partner' }} readOnly={!canManagePartnerWide} />;
}

function LoadedPolicy({ owner, readOnly = false }: Props) {
  const { t } = useTranslation('callerVerificationTech');
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [draft, setDraft] = useState<PolicyDraft>(inheritedDraft);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const org = owner.ownerScope === 'organization';
  const orgId = org ? owner.orgId : null;

  useEffect(() => {
    const c = new AbortController();
    setError(false);
    getPolicy(org && orgId ? { ownerScope: 'organization', orgId } : { ownerScope: 'partner' }, c.signal)
      .then((r) => { if (!c.signal.aborted) { setData(r); setDraft(draftFrom(r.row)); } })
      .catch(() => { if (!c.signal.aborted) setError(true); });
    return () => c.abort();
  }, [org, orgId, revision]);

  if (error) {
    return (
      <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>{t('policy.loadFailed')}</p>
        <button type="button" className="underline" onClick={() => setRevision((n) => n + 1)}>{t('retry')}</button>
      </div>
    );
  }
  if (!data) return <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>;

  // The value an untouched (null) field resolves to: the partner baseline for
  // an org override, the built-in default for the partner baseline itself.
  const inherited = (key: keyof PolicyValues) => (org ? data.baseline[key] : data.defaults[key]);
  const value = (key: keyof PolicyValues) => draft[key] ?? inherited(key);
  const update = (key: keyof PolicyValues, next: unknown) => setDraft((old) => ({ ...old, [key]: next }));
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') || '—' : typeof v === 'boolean' ? (v ? t('policy.yes') : t('policy.no')) : String(v));
  const fieldLabel = (key: string) => t(/* i18n-dynamic */ `policy.fields.${key}`);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current || readOnly) return;
    busy.current = true;
    setSaving(true);
    try {
      const result = await putPolicy(owner, draft);
      setData(result);
      setDraft(draftFrom(result.row));
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <form className="space-y-4 rounded-md border p-4 text-sm" onSubmit={(e) => void save(e)} data-testid="cv-policy-form">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{t('policy.title')}</h3>
        {!org && <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">{t('policy.allOrgs')}</span>}
      </div>
      <p className="text-muted-foreground">{org ? t('policy.orgHelp') : t('policy.partnerHelp')}</p>
      {readOnly && <p className="text-muted-foreground">{t('policy.readOnly')}</p>}
      {data.effective.ignored.length > 0 && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2 text-warning">
          {t('policy.ignored', { fields: data.effective.ignored.map(fieldLabel).join(', ') })}
        </p>
      )}
      <fieldset disabled={readOnly || saving} className="space-y-3">
        {KEYS.map((key) => {
          const id = `cv-policy-${key}`;
          const num = NUMERIC[key as keyof typeof NUMERIC];
          const bool = BOOLEANS[key as keyof typeof BOOLEANS];
          const options = SETS[key as keyof typeof SETS];
          const base = data.baseline[key];
          const min = num ? (org && num[2] === 'max' ? Math.max(num[0], base as number) : num[0]) : undefined;
          const max = num ? (org && num[2] === 'min' ? Math.min(num[1], base as number) : num[1]) : undefined;
          return (
            <div key={key} className="grid gap-1 border-b pb-3 last:border-0 sm:grid-cols-[1fr_auto] sm:items-start">
              <div className="space-y-1">
                <label htmlFor={id} className="font-medium">{fieldLabel(key)}</label>
                <p className="text-xs text-muted-foreground">
                  <span data-testid={`${id}-source`} className="mr-2 rounded border px-1.5 py-0.5">
                    {t(/* i18n-dynamic */ `policy.source.${data.effective.provenance[key] ?? 'default'}`)}
                  </span>
                  {draft[key] === null && t('policy.inherited', { value: show(inherited(key)) })}
                  <output data-testid={`${id}-effective`} className="sr-only">{show(data.effective[key])}</output>
                </p>
                {num && (
                  <NumberField id={id} min={min!} max={max!} value={value(key) as number} onCommit={(n) => update(key, n)} />
                )}
                {bool && (
                  <select id={id} data-testid={id} value={String(value(key))} className="h-8 rounded-md border bg-background px-2"
                    onChange={(e) => update(key, e.target.value === 'true')}>
                    {[true, false].map((v) => (
                      <option key={String(v)} value={String(v)}
                        disabled={org && ((bool === 'or' && base === true && !v) || (bool === 'and' && base === false && v))}>
                        {v ? t('policy.yes') : t('policy.no')}
                      </option>
                    ))}
                  </select>
                )}
                {options && (
                  <div id={id} className="flex flex-wrap gap-3">
                    {options.map((option) => {
                      const values = value(key) as string[];
                      const forbidden = org && !(base as string[]).includes(option);
                      return (
                        <label key={option} className="inline-flex items-center gap-1">
                          <input type="checkbox" data-testid={`${id}-${option}`} disabled={forbidden} checked={values.includes(option) && !forbidden}
                            onChange={(e) => update(key, e.target.checked ? [...values, option] : values.filter((v) => v !== option))} />
                          {key === 'allowedMethods' ? t(/* i18n-dynamic */ `methods.${option}`) : t(/* i18n-dynamic */ `policy.roles.${option}`)}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              {draft[key] !== null && !readOnly && (
                <button type="button" data-testid={`${id}-inherit`} className="justify-self-start text-xs underline sm:justify-self-end"
                  onClick={() => update(key, null)}>{t('policy.inherit')}</button>
              )}
            </div>
          );
        })}
      </fieldset>
      {!readOnly && (
        <div className="flex justify-end">
          <button type="submit" data-testid="cv-policy-save" disabled={saving}
            className="h-9 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">
            {saving ? t('policy.saving') : t('policy.save')}
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * Integer input that keeps the raw text while typing (so "3" on the way to
 * "30" is not rejected) and commits on blur or Enter, clamped to [min, max]; an empty
 * or non-numeric entry reverts to the current value.
 */
function NumberField({ id, min, max, value, onCommit }: { id: string; min: number; max: number; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  // Re-sync the text when the committed value changes, during render rather
  // than in an effect: a pending mount effect is flushed ahead of the next
  // keystroke's re-render and would overwrite what was just typed (#8879).
  const [synced, setSynced] = useState(value);
  if (!Object.is(synced, value)) {
    setSynced(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n)) { setText(String(value)); return; }
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input id={id} data-testid={id} type="number" step={1} min={min} max={max} value={text}
      className="h-8 w-28 rounded-md border bg-background px-2"
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}
