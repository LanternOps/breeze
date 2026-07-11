import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims, loginPathWithNext } from '../../lib/authScope';
import { buildResponseValidator, coerceFormResponses, type TicketFormField } from '@breeze/shared';
import TicketFormFields from './TicketFormFields';
import type { TicketPriority } from './ticketConfig';

interface Option { id: string; name: string }
interface CategoryOption { id: string; name: string; parentId: string | null }
interface RequesterOption { id: string; name: string | null; email: string }
interface AvailableTicketForm {
  id: string; name: string; description: string | null; categoryId: string | null;
  fields: TicketFormField[]; defaultPriority: TicketPriority | null; titleTemplate: string | null;
}

// Sentinel for the "type a requester manually" choice in the select.
const MANUAL_REQUESTER = '__manual__';

export default function CreateTicketPage() {
  const { t } = useTranslation('tickets');
  const [orgs, setOrgs] = useState<Option[]>([]);
  const [devices, setDevices] = useState<Option[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [orgId, setOrgId] = useState('');
  const [orgLocked, setOrgLocked] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [requesters, setRequesters] = useState<RequesterOption[]>([]);
  const [requesterId, setRequesterId] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterEmail, setRequesterEmail] = useState('');
  const [forms, setForms] = useState<AvailableTicketForm[]>([]);
  const [formId, setFormId] = useState('');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const selectedForm = forms.find((f) => f.id === formId) ?? null;

  const loadOptions = useCallback(async () => {
    setLoadError(false);
    const claims = getJwtClaims();
    const isOrgScoped = claims.scope === 'organization' && !!claims.orgId;
    try {
      const [orgRes, catRes] = await Promise.all([
        // Org-scoped users can't list organizations (and don't need to — the org
        // is fixed by the session); skip the call instead of dead-ending on 403.
        isOrgScoped ? Promise.resolve(null) : fetchWithAuth('/orgs/organizations?limit=100'),
        fetchWithAuth('/ticket-categories')
      ]);
      if (isOrgScoped) {
        setOrgId(claims.orgId as string);
        setOrgLocked(true);
      } else if (orgRes && orgRes.ok) {
        const b = await orgRes.json();
        setOrgs((b.data ?? b.organizations ?? []).map((o: { id: string; name: string }) => ({ id: o.id, name: o.name })));
      } else {
        // 403 here usually means an org-scoped session whose token landed after
        // mount — re-read the claims before declaring failure.
        const late = getJwtClaims();
        if (orgRes?.status === 403 && late.scope === 'organization' && late.orgId) {
          setOrgId(late.orgId);
          setOrgLocked(true);
        } else {
          setLoadError(true);
          return;
        }
      }
      if (catRes.ok) {
        const cb = await catRes.json();
        setCategories(
          (cb.data ?? [])
            .filter((c: { isActive: boolean }) => c.isActive)
            .map((c: { id: string; name: string; parentId?: string | null }) => ({
              id: c.id,
              name: c.name,
              parentId: c.parentId ?? null
            }))
        );
      }
      // else: category is an optional field — degrade to "None" rather than blocking the form.
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void loadOptions(); }, [loadOptions]);

  // Build "Parent / Child" labels for category options; plain name when no parent.
  const categoryLabel = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return (c: CategoryOption) => {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return parent ? `${parent.name} / ${c.name}` : c.name;
    };
  }, [categories]);

  useEffect(() => {
    if (!orgId) { setDevices([]); setDeviceId(''); return; }
    // Reset on every org change — a stale deviceId from the previous org would
    // submit a cross-org device (the select only LOOKS cleared once options swap).
    setDeviceId('');
    void (async () => {
      const res = await fetchWithAuth(`/devices?orgId=${orgId}`);
      if (res.ok) {
        const b = await res.json();
        setDevices((b.data ?? b.devices ?? []).map((d: { id: string; displayName?: string; hostname?: string }) => ({
          id: d.id, name: d.displayName ?? d.hostname ?? d.id
        })));
      }
    })();
  }, [orgId]);

  // Requester options follow the org (a portal user is scoped to one org). Reset
  // the selection on org change so a stale requester from the previous org can't
  // be submitted — the API rejects a cross-org requester, but clear it up front.
  useEffect(() => {
    setRequesterId(''); setRequesterName(''); setRequesterEmail('');
    if (!orgId) { setRequesters([]); return; }
    // `cancelled` guards against a late response from a previous org clobbering
    // the current list (mirrors the device effect's reset intent).
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/tickets/requesters?orgId=${orgId}`);
        const b = res.ok ? await res.json() : null;
        if (cancelled) return;
        // Requester is optional — degrade to free-text entry rather than blocking.
        setRequesters((b?.data ?? []) as RequesterOption[]);
      } catch {
        if (!cancelled) setRequesters([]);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // Intake forms follow the org. They're purely additive — a fetch failure must
  // silently degrade to the blank-ticket path (no picker, no toast). Reset the
  // selection + entered values on every org change so nothing leaks across orgs.
  useEffect(() => {
    setForms([]); setFormId(''); setFormValues({}); setFormErrors({});
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/ticket-forms/available?orgId=${encodeURIComponent(orgId)}`);
        if (cancelled) return;
        if (res.ok) {
          const body = await res.json();
          setForms((body.data ?? []) as AvailableTicketForm[]);
        } else {
          // Forms are additive — degrade to a blank ticket (no toast), but leave
          // a breadcrumb so a broken picker isn't invisible in the console.
          console.warn('[create-ticket] forms fetch failed', res.status);
        }
      } catch (err) {
        if (!cancelled) console.warn('[create-ticket] forms fetch failed', err);
        /* forms are additive — degrade to a blank ticket */
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    // With a form selected the server composes the subject from titleTemplate, so
    // a blank subject is fine; without a form the subject stays required.
    if (!orgId || (!subject.trim() && !selectedForm)) return;

    // Validate the form responses client-side for inline errors before POSTing.
    // The API re-validates authoritatively — this is a UX fast-path, not the gate.
    let responses: Record<string, unknown> | undefined;
    if (selectedForm) {
      const coerced = coerceFormResponses(selectedForm.fields, formValues);
      const parsed = buildResponseValidator(selectedForm.fields).safeParse(coerced);
      if (!parsed.success) {
        const errs: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? '');
          // 'invalid_type: received undefined' on a missing required field reads badly — normalize.
          if (key && !errs[key]) errs[key] = issue.code === 'invalid_type' && coerced[key] === undefined ? 'This field is required' : issue.message;
        }
        // Guard against a silent no-op: if no issue mapped to a field key, surface
        // a generic form-level error so validation failure is never invisible.
        if (Object.keys(errs).length === 0) {
          errs.__form = 'Some responses are invalid. Please review the form and try again.';
        }
        setFormErrors(errs);
        return;
      }
      setFormErrors({});
      responses = parsed.data as Record<string, unknown>;
    }

    setSaving(true);
    try {
      const created = await runAction<{ data: { id: string; internalNumber: string | null } }>({
        request: () => fetchWithAuth('/tickets', {
          method: 'POST',
          body: JSON.stringify({
            orgId,
            subject: subject.trim() || undefined,
            description: description.trim() || undefined,
            deviceId: deviceId || undefined,
            categoryId: categoryId || undefined,
            priority,
            // Requester: a picked portal user, or a free-text name/email. Omit
            // everything when left blank — the API then defaults the requester to
            // the creating staff member (legacy behaviour).
            ...(requesterId && requesterId !== MANUAL_REQUESTER ? { submittedBy: requesterId } : {}),
            ...(requesterId === MANUAL_REQUESTER && requesterName.trim() ? { submitterName: requesterName.trim() } : {}),
            ...(requesterId === MANUAL_REQUESTER && requesterEmail.trim() ? { submitterEmail: requesterEmail.trim() } : {}),
            ...(selectedForm ? { formId: selectedForm.id, formResponses: responses } : {})
          })
        }),
        errorFallback: t('createTicketPage.creationFailed'),
        successMessage: (r) => t('createTicketPage.createdToast', { number: r.data.internalNumber ?? '' }),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      void navigateTo(`/tickets#${created.data.internalNumber ?? created.data.id}`);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [orgId, subject, description, deviceId, categoryId, priority, requesterId, requesterName, requesterEmail, selectedForm, formValues, t]);

  const selectCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold" data-testid="create-ticket-heading">{t('createTicketPage.title')}</h1>
        <div className="py-12 text-center" data-testid="create-ticket-load-error">
          <p className="text-sm text-muted-foreground">{t('createTicketPage.orgsLoadFailed')}</p>
          <button type="button" onClick={() => void loadOptions()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="create-ticket-load-retry">{t('common:actions.retry')}</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4" data-testid="create-ticket-form">
      <h1 className="text-xl font-semibold" data-testid="create-ticket-heading">{t('createTicketPage.title')}</h1>
      {!orgLocked && (
        <div>
          <label className="text-sm font-medium" htmlFor="ct-org">{t('common:labels.organization')}</label>
          <select id="ct-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} required className={selectCls} data-testid="create-ticket-org-input">
            <option value="">{t('createTicketPage.selectOrganization')}</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
      {forms.length > 0 && (
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="ct-form">Start from a form <span className="text-muted-foreground">(optional)</span></label>
          <select
            id="ct-form"
            data-testid="create-ticket-form-picker"
            className={selectCls}
            value={formId}
            onChange={(e) => {
              const next = forms.find((f) => f.id === e.target.value) ?? null;
              setFormId(e.target.value);
              setFormErrors({});
              if (next) {
                const defaults: Record<string, unknown> = {};
                for (const f of next.fields) if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
                setFormValues(defaults);
                // Only adopt the form's category when it's actually in the loaded
                // options — otherwise we'd invisibly attach an inactive/unloaded
                // category the user can neither see nor change.
                if (next.categoryId && categories.some((c) => c.id === next.categoryId)) setCategoryId(next.categoryId);
                if (next.defaultPriority) setPriority(next.defaultPriority);
              } else {
                setFormValues({});
              }
            }}
          >
            <option value="">Blank ticket</option>
            {forms.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
          </select>
          {selectedForm?.description && <p className="mt-1 text-xs text-muted-foreground">{selectedForm.description}</p>}
        </div>
      )}
      {selectedForm && (
        <>
          {formErrors.__form && (
            <p className="text-sm text-destructive" data-testid="create-ticket-form-error">{formErrors.__form}</p>
          )}
          <TicketFormFields
            fields={selectedForm.fields}
            values={formValues}
            errors={formErrors}
            onChange={(key, value) => setFormValues((v) => ({ ...v, [key]: value }))}
          />
        </>
      )}
      <div>
        <label className="text-sm font-medium" htmlFor="ct-subject">{t('createTicketPage.subject')}</label>
        <input id="ct-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required={!selectedForm} maxLength={255} className={selectCls} data-testid="create-ticket-subject-input" />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-desc">{t('common:labels.description')}</label>
        <textarea id="ct-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={5} className={selectCls} data-testid="create-ticket-description-input" />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-requester">{t('createTicketPage.requesterOptional')}</label>
        <select
          id="ct-requester"
          value={requesterId}
          onChange={(e) => setRequesterId(e.target.value)}
          disabled={!orgId}
          className={selectCls}
          data-testid="create-ticket-requester-input"
        >
          <option value="">{t('createTicketPage.defaultYou')}</option>
          {requesters.map((r) => (
            <option key={r.id} value={r.id}>{r.name ? `${r.name} (${r.email})` : r.email}</option>
          ))}
          <option value={MANUAL_REQUESTER}>{t('createTicketPage.someoneElse')}</option>
        </select>
        {requesterId === MANUAL_REQUESTER && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
              maxLength={255}
              placeholder={t('common:labels.name')}
              aria-label={t('createTicketPage.requesterName')}
              className={selectCls}
              data-testid="create-ticket-requester-name-input"
            />
            <input
              type="email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              maxLength={255}
              placeholder={t('createTicketPage.emailOptional')}
              aria-label={t('createTicketPage.requesterEmail')}
              className={selectCls}
              data-testid="create-ticket-requester-email-input"
            />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="text-sm font-medium" htmlFor="ct-device">{t('createTicketPage.deviceOptional')}</label>
          <select id="ct-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={!orgId} className={selectCls} data-testid="create-ticket-device-input">
            <option value="">{t('common:labels.none')}</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ct-cat">{t('createTicketPage.category')}</label>
          <select id="ct-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectCls} data-testid="create-ticket-category-input">
            <option value="">{t('common:labels.none')}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c)}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ct-pri">{t('createTicketPage.priority')}</label>
          <select id="ct-pri" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className={selectCls} data-testid="create-ticket-priority-input">
            <option value="low">{t('createTicketPage.priorityOptions.low')}</option><option value="normal">{t('createTicketPage.priorityOptions.normal')}</option><option value="high">{t('createTicketPage.priorityOptions.high')}</option><option value="urgent">{t('createTicketPage.priorityOptions.urgent')}</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <a href="/tickets" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="create-ticket-cancel">{t('common:actions.cancel')}</a>
        <button type="submit" disabled={saving || !orgId || (!subject.trim() && !selectedForm)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" data-testid="create-ticket-submit">
          {saving ? t('createTicketPage.creating') : t('createTicketPage.createTicket')}
        </button>
      </div>
    </form>
  );
}
