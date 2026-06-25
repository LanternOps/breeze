import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { getJwtClaims, loginPathWithNext } from '../../lib/authScope';
import type { TicketPriority } from './ticketConfig';

interface Option { id: string; name: string }
interface CategoryOption { id: string; name: string; parentId: string | null }
interface RequesterOption { id: string; name: string | null; email: string }

// Sentinel for the "type a requester manually" choice in the select.
const MANUAL_REQUESTER = '__manual__';

export default function CreateTicketPage() {
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
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

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

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !subject.trim()) return;
    setSaving(true);
    try {
      const created = await runAction<{ data: { id: string; internalNumber: string | null } }>({
        request: () => fetchWithAuth('/tickets', {
          method: 'POST',
          body: JSON.stringify({
            orgId,
            subject: subject.trim(),
            description: description.trim() || undefined,
            deviceId: deviceId || undefined,
            categoryId: categoryId || undefined,
            priority,
            // Requester: a picked portal user, or a free-text name/email. Omit
            // everything when left blank — the API then defaults the requester to
            // the creating staff member (legacy behaviour).
            ...(requesterId && requesterId !== MANUAL_REQUESTER ? { submittedBy: requesterId } : {}),
            ...(requesterId === MANUAL_REQUESTER && requesterName.trim() ? { submitterName: requesterName.trim() } : {}),
            ...(requesterId === MANUAL_REQUESTER && requesterEmail.trim() ? { submitterEmail: requesterEmail.trim() } : {})
          })
        }),
        errorFallback: 'Ticket creation failed. Retry.',
        successMessage: (r) => `Ticket ${r.data.internalNumber ?? ''} created`,
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      void navigateTo(`/tickets#${created.data.internalNumber ?? created.data.id}`);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [orgId, subject, description, deviceId, categoryId, priority, requesterId, requesterName, requesterEmail]);

  const selectCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold" data-testid="create-ticket-heading">Create ticket</h1>
        <div className="py-12 text-center" data-testid="create-ticket-load-error">
          <p className="text-sm text-muted-foreground">Organizations failed to load.</p>
          <button type="button" onClick={() => void loadOptions()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="create-ticket-load-retry">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4" data-testid="create-ticket-form">
      <h1 className="text-xl font-semibold" data-testid="create-ticket-heading">Create ticket</h1>
      {!orgLocked && (
        <div>
          <label className="text-sm font-medium" htmlFor="ct-org">Organization</label>
          <select id="ct-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} required className={selectCls} data-testid="create-ticket-org-input">
            <option value="">Select organization</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="text-sm font-medium" htmlFor="ct-subject">Subject</label>
        <input id="ct-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={255} className={selectCls} data-testid="create-ticket-subject-input" />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-desc">Description</label>
        <textarea id="ct-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={5} className={selectCls} data-testid="create-ticket-description-input" />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-requester">Requester (optional)</label>
        <select
          id="ct-requester"
          value={requesterId}
          onChange={(e) => setRequesterId(e.target.value)}
          disabled={!orgId}
          className={selectCls}
          data-testid="create-ticket-requester-input"
        >
          <option value="">Default (you)</option>
          {requesters.map((r) => (
            <option key={r.id} value={r.id}>{r.name ? `${r.name} (${r.email})` : r.email}</option>
          ))}
          <option value={MANUAL_REQUESTER}>Someone else…</option>
        </select>
        {requesterId === MANUAL_REQUESTER && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
              maxLength={255}
              placeholder="Name"
              aria-label="Requester name"
              className={selectCls}
              data-testid="create-ticket-requester-name-input"
            />
            <input
              type="email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              maxLength={255}
              placeholder="Email (optional)"
              aria-label="Requester email"
              className={selectCls}
              data-testid="create-ticket-requester-email-input"
            />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="text-sm font-medium" htmlFor="ct-device">Device (optional)</label>
          <select id="ct-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={!orgId} className={selectCls} data-testid="create-ticket-device-input">
            <option value="">None</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ct-cat">Category</label>
          <select id="ct-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectCls} data-testid="create-ticket-category-input">
            <option value="">None</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c)}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ct-pri">Priority</label>
          <select id="ct-pri" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className={selectCls} data-testid="create-ticket-priority-input">
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <a href="/tickets" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="create-ticket-cancel">Cancel</a>
        <button type="submit" disabled={saving || !orgId || !subject.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" data-testid="create-ticket-submit">
          {saving ? 'Creating' : 'Create ticket'}
        </button>
      </div>
    </form>
  );
}
