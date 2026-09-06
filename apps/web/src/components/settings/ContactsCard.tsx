import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '@/lib/runAction';
import BulkContactImport from '../organizations/BulkContactImport';

/**
 * First-class organization contacts (#3258 W04) — the whole `#contacts` tab of
 * the organization settings page.
 *
 * Contract: apps/api/src/routes/orgContacts.ts. Note the asymmetry in the
 * paths — the list and create routes are organization-scoped
 * (`/orgs/organizations/:id/contacts`) while update and delete are not
 * (`/orgs/contacts/:contactId`), because the server re-asserts reach from the
 * contact's own scope rather than trusting an organization in the URL.
 */

const PAGE_SIZE = 25;

/** Mirrors CONTACT_ROLES in apps/api/src/services/contacts/types.ts. */
const CONTACT_ROLES = [
  'billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal',
] as const;
type ContactRole = (typeof CONTACT_ROLES)[number];

/**
 * Role → label key. A record of full key strings rather than a template, so a
 * role token that is not camelCase (`after_hours`) needs no transformation at
 * the call site.
 */
const ROLE_LABEL_KEYS: Record<ContactRole, string> = {
  'billing': 'contactsCard.roles.billing',
  'technical': 'contactsCard.roles.technical',
  'escalation': 'contactsCard.roles.escalation',
  'admin': 'contactsCard.roles.admin',
  'site': 'contactsCard.roles.site',
  'after_hours': 'contactsCard.roles.afterHours',
  'portal': 'contactsCard.roles.portal',
};

function isKnownRole(role: string): role is ContactRole {
  return (CONTACT_ROLES as readonly string[]).includes(role);
}

type Contact = {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  roles: string[];
  isPrimary: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type SiteOption = { id: string; name: string };

/** The four fields `contacts_identifiable_chk` accepts; a row needs one. */
const IDENTIFIER_FIELDS = ['name', 'email', 'phone', 'mobile'] as const;

type Draft = {
  siteId: string;
  name: string;
  email: string;
  phone: string;
  mobile: string;
  title: string;
  notes: string;
  roles: string[];
  isPrimary: boolean;
};

const EMPTY_DRAFT: Draft = {
  siteId: '', name: '', email: '', phone: '', mobile: '', title: '', notes: '',
  roles: [], isPrimary: false,
};

function draftFrom(contact: Contact): Draft {
  return {
    siteId: contact.siteId ?? '',
    name: contact.name ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    mobile: contact.mobile ?? '',
    title: contact.title ?? '',
    notes: contact.notes ?? '',
    roles: [...contact.roles],
    isPrimary: contact.isPrimary,
  };
}

/**
 * Blank means CLEAR, not "leave alone": every field the form renders is one the
 * operator can see, so an emptied box is a deliberate erasure. The server
 * distinguishes the two — an explicit `null` clears, an omitted key does not —
 * and sending `''` instead would be rejected for `siteId` and stored as a blank
 * string nowhere else. (The IMPORTER takes the opposite reading, because a
 * blank CSV cell is overwhelmingly an exporter with nothing to say.)
 */
function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function draftBody(draft: Draft): Record<string, unknown> {
  return {
    siteId: draft.siteId === '' ? null : draft.siteId,
    name: nullable(draft.name),
    email: nullable(draft.email),
    phone: nullable(draft.phone),
    mobile: nullable(draft.mobile),
    title: nullable(draft.title),
    notes: nullable(draft.notes),
    roles: draft.roles,
    isPrimary: draft.isPrimary,
  };
}

/** A create sends only what was filled in — the server refines on the whole object. */
function createBody(draft: Draft): Record<string, unknown> {
  const full = draftBody(draft);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === false) continue;
    body[key] = value;
  }
  return body;
}

type ContactsCardProps = { orgId: string };

export default function ContactsCard({ orgId }: ContactsCardProps) {
  const { t } = useTranslation('settings');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [page, setPage] = useState(1);
  const [siteFilter, setSiteFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [sitesError, setSitesError] = useState(false);
  /** Bumped by the sites retry button; the sites effect keys off it. */
  const [sitesAttempt, setSitesAttempt] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  /**
   * Monotonic request id. `loadContacts` is fired from an effect AND from every
   * mutation, so two loads can be in flight at once (change a filter mid-delete);
   * without this the slower response wins and paints a list nobody asked for.
   */
  const loadSeq = useRef(0);

  const unauthorized = useCallback(() => { void navigateTo('/login', { replace: true }); }, []);

  /**
   * Site id → name, or null when this screen has no name for it. Reachable in
   * ordinary use, so the fallback copy must NOT read as a permission verdict:
   * the list route already intersects the caller's allowed sites, and the picker
   * above fetches `limit=100` without paging, so an organization's 101st site
   * resolves to nothing here purely because the name was never fetched. A failed
   * sites call (see `sitesError`) takes the same path.
   */
  const siteName = useCallback(
    (siteId: string | null) => sites.find((s) => s.id === siteId)?.name ?? null,
    [sites],
  );

  const loadContacts = useCallback(async () => {
    const seq = (loadSeq.current += 1);
    const superseded = () => seq !== loadSeq.current;
    setLoading(true);
    setLoadError(false);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (siteFilter) params.set('siteId', siteFilter);
    if (roleFilter) params.set('role', roleFilter);
    // Set only on the clamp path below, where `loading` must stay true across the
    // re-fetch so the emptied page never flashes as "No contacts yet".
    let clamping = false;
    try {
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}/contacts?${params.toString()}`);
      if (superseded()) return;
      if (res.status === 401) return unauthorized();
      if (!res.ok) throw new Error(`contacts load failed: ${res.status}`);
      const body = (await res.json()) as {
        data: Contact[];
        pagination: { total: number };
      };
      if (superseded()) return;
      const rows = body.data ?? [];
      const count = body.pagination?.total ?? 0;
      const lastPage = Math.max(1, Math.ceil(count / PAGE_SIZE));
      // Deleting the last row of page N leaves that page empty and the pagination
      // block unmounted, stranding the operator on "No contacts yet" with rows
      // still on page N-1. Walk back to the page that now holds the end of the
      // list and let the effect re-fetch it.
      if (rows.length === 0 && page > 1 && lastPage < page) {
        clamping = true;
        setTotal(count);
        setPage(lastPage);
        return;
      }
      setContacts(rows);
      setTotal(count);
    } catch (err) {
      if (superseded()) return;
      console.warn('[ContactsCard] contacts load failed', err);
      setLoadError(true);
    } finally {
      if (!clamping && !superseded()) setLoading(false);
    }
  }, [orgId, page, siteFilter, roleFilter, unauthorized]);

  useEffect(() => { void loadContacts(); }, [loadContacts]);

  // Sites come from THIS organization, not from useOrgStore().sites: the store
  // holds the globally selected org's sites, which is a different org whenever
  // an admin opens one tenant's settings while another is selected in the
  // header. A stale list here would mislabel every site attribution on screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}&limit=100`);
        if (res.status === 401) return unauthorized();
        if (!res.ok) throw new Error(`sites load failed: ${res.status}`);
        const body = (await res.json()) as { data?: SiteOption[] } | SiteOption[];
        const data = Array.isArray(body) ? body : (body.data ?? []);
        if (cancelled) return;
        setSites(data.map((s) => ({ id: s.id, name: s.name })));
        setSitesError(false);
      } catch (err) {
        // Site names are not decoration: they also populate the site FILTER and
        // the form's site select, so a silent failure looks like an organization
        // with no sites. Surfaced as a non-blocking notice — the contacts
        // themselves are organization-scoped and stay fully usable.
        console.warn('[ContactsCard] sites load failed', err);
        if (!cancelled) setSitesError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, unauthorized, sitesAttempt]);

  function changeFilter(next: () => void) {
    // A filter narrows the result set, so whatever page the user was on is
    // almost certainly past the end of the new one.
    setPage(1);
    next();
  }

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setFormOpen(true);
  }

  function openEdit(contact: Contact) {
    setEditing(contact);
    setDraft(draftFrom(contact));
    setFormOpen(true);
  }

  const draftHasIdentifier = IDENTIFIER_FIELDS.some((f) => draft[f].trim() !== '');

  async function save() {
    if (saving || !draftHasIdentifier) return;
    setSaving(true);
    try {
      await runAction({
        request: () => (editing
          ? fetchWithAuth(`/orgs/contacts/${editing.id}`, {
              method: 'PATCH',
              body: JSON.stringify(draftBody(draft)),
            })
          : fetchWithAuth(`/orgs/organizations/${orgId}/contacts`, {
              method: 'POST',
              body: JSON.stringify(createBody(draft)),
            })),
        errorFallback: editing
          ? t('contactsCard.errors.update')
          : t('contactsCard.errors.create'),
        successMessage: editing
          ? t('contactsCard.toasts.updated')
          : t('contactsCard.toasts.created'),
        onUnauthorized: unauthorized,
      });
      setFormOpen(false);
      setEditing(null);
      setDraft(EMPTY_DRAFT);
      // Refetch rather than patch: promoting a primary DEMOTES the previous one
      // in the same scope server-side, and no client-side guess reproduces that
      // without re-implementing the scope rule.
      await loadContacts();
    } catch (err) {
      // A refused save leaves the form open with the operator's input intact.
      // Never rethrow: `save` is called through `void save()`, so a throw here
      // becomes an unhandled rejection rather than anything the user can see.
      handleActionError(err, t('contactsCard.errors.update'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(contact: Contact) {
    if (deletingId) return;
    const label = contact.name ?? contact.email ?? contact.phone ?? contact.mobile ?? '';
    if (!window.confirm(t('contactsCard.confirmDelete', { name: label }))) return;
    setDeletingId(contact.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/contacts/${contact.id}`, { method: 'DELETE' }),
        errorFallback: t('contactsCard.errors.delete'),
        successMessage: t('contactsCard.toasts.deleted'),
        onUnauthorized: unauthorized,
      });
      await loadContacts();
    } catch (err) {
      // Same contract as `save`: called through `void remove(c)`, so a rethrow
      // would surface as an unhandled rejection instead of a toast.
      handleActionError(err, t('contactsCard.errors.delete'));
    } finally {
      setDeletingId(null);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, total);

  const roleOptions = useMemo(
    () => CONTACT_ROLES.map((role) => ({ role, key: ROLE_LABEL_KEYS[role] })),
    [],
  );

  function toggleRole(role: ContactRole) {
    setDraft((prev) => ({
      ...prev,
      roles: prev.roles.includes(role)
        ? prev.roles.filter((r) => r !== role)
        : [...prev.roles, role],
    }));
  }

  return (
    <div data-testid="org-contacts-card" className="space-y-4">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('contactsCard.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('contactsCard.description')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="org-contacts-import-button"
              onClick={() => setShowImport((v) => !v)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('contactsCard.actions.import')}
            </button>
            <button
              type="button"
              data-testid="org-contacts-add-button"
              onClick={openCreate}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('contactsCard.actions.add')}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block text-xs">
            <span className="text-muted-foreground">{t('contactsCard.filters.site')}</span>
            <select
              data-testid="org-contacts-filter-site"
              value={siteFilter}
              onChange={(e) => changeFilter(() => setSiteFilter(e.target.value))}
              className="mt-1 h-8 w-48 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">{t('contactsCard.filters.allSites')}</option>
              <option value="none">{t('contactsCard.organizationLevel')}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">{t('contactsCard.filters.role')}</span>
            <select
              data-testid="org-contacts-filter-role"
              value={roleFilter}
              onChange={(e) => changeFilter(() => setRoleFilter(e.target.value))}
              className="mt-1 h-8 w-48 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">{t('contactsCard.filters.allRoles')}</option>
              {roleOptions.map(({ role, key }) => (
                <option key={role} value={role}>{t(/* i18n-dynamic */ key)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {sitesError && (
        <div
          data-testid="org-contacts-sites-error"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
        >
          {t('contactsCard.errors.sites')}{' '}
          <button
            type="button"
            data-testid="org-contacts-sites-retry"
            onClick={() => setSitesAttempt((n) => n + 1)}
            className="underline hover:text-foreground"
          >
            {t('contactsCard.actions.retry')}
          </button>
        </div>
      )}

      {showImport && (
        <BulkContactImport
          orgId={orgId}
          onImported={() => { void loadContacts(); }}
          onUnauthorized={unauthorized}
          onClose={() => setShowImport(false)}
        />
      )}

      {formOpen && (
        <div data-testid="contact-form" className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold">
            {editing ? t('contactsCard.form.editHeading') : t('contactsCard.form.addHeading')}
          </h3>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <label className="block text-xs">
              <span className="text-muted-foreground">{t('contactsCard.form.fields.name')}</span>
              <input
                data-testid="contact-form-name-input"
                value={draft.name}
                onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">{t('contactsCard.form.fields.email')}</span>
              <input
                type="email"
                data-testid="contact-form-email-input"
                value={draft.email}
                onChange={(e) => setDraft((p) => ({ ...p, email: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">{t('contactsCard.form.fields.phone')}</span>
              <input
                data-testid="contact-form-phone-input"
                value={draft.phone}
                onChange={(e) => setDraft((p) => ({ ...p, phone: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">{t('contactsCard.form.fields.mobile')}</span>
              <input
                data-testid="contact-form-mobile-input"
                value={draft.mobile}
                onChange={(e) => setDraft((p) => ({ ...p, mobile: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">{t('contactsCard.form.fields.title')}</span>
              <input
                data-testid="contact-form-title-input"
                value={draft.title}
                onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">{t('contactsCard.form.fields.site')}</span>
              <select
                data-testid="contact-form-site-select"
                value={draft.siteId}
                onChange={(e) => setDraft((p) => ({ ...p, siteId: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">{t('contactsCard.organizationLevel')}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="mt-4">
            <legend className="text-xs text-muted-foreground">
              {t('contactsCard.form.fields.roles')}
            </legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {roleOptions.map(({ role, key }) => (
                <label key={role} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    data-testid={`contact-form-role-${role}`}
                    checked={draft.roles.includes(role)}
                    onChange={() => toggleRole(role)}
                  />
                  <span>{t(/* i18n-dynamic */ key)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="mt-4 block text-xs">
            <span className="text-muted-foreground">{t('contactsCard.form.fields.notes')}</span>
            <textarea
              data-testid="contact-form-notes-input"
              value={draft.notes}
              rows={2}
              onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>

          <label className="mt-4 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="contact-form-primary-input"
              checked={draft.isPrimary}
              onChange={(e) => setDraft((p) => ({ ...p, isPrimary: e.target.checked }))}
            />
            <span>{t('contactsCard.form.fields.isPrimary')}</span>
          </label>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="contact-form-submit"
              onClick={() => void save()}
              disabled={saving || !draftHasIdentifier}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t('contactsCard.actions.saving') : t('contactsCard.actions.save')}
            </button>
            <button
              type="button"
              data-testid="contact-form-cancel"
              onClick={() => { setFormOpen(false); setEditing(null); }}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              {t('contactsCard.actions.cancel')}
            </button>
            {!draftHasIdentifier && (
              <span data-testid="contact-form-identifier-hint" className="text-xs text-muted-foreground">
                {t('contactsCard.form.identifierRequired')}
              </span>
            )}
          </div>
        </div>
      )}

      {loading && contacts.length === 0 && !loadError && (
        <p data-testid="org-contacts-loading" className="text-sm text-muted-foreground">
          {t('contactsCard.loading')}
        </p>
      )}

      {loadError && (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-contacts-load-error">
          {t('contactsCard.errors.load')}{' '}
          <button type="button" onClick={() => void loadContacts()} className="underline hover:text-foreground">
            {t('contactsCard.actions.retry')}
          </button>
        </div>
      )}

      {!loadError && !loading && contacts.length === 0 && (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-contacts-empty">
          {t('contactsCard.empty')}
        </div>
      )}

      {!loadError && contacts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm" data-testid="org-contacts-table">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">{t('contactsCard.columns.name')}</th>
                <th className="px-3 py-2">{t('contactsCard.columns.reach')}</th>
                <th className="px-3 py-2">{t('contactsCard.columns.jobTitle')}</th>
                <th className="px-3 py-2">{t('contactsCard.columns.roles')}</th>
                <th className="px-3 py-2">{t('contactsCard.columns.site')}</th>
                <th className="px-3 py-2 text-right">{t('contactsCard.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
                const pinned = siteName(c.siteId);
                return (
                  <tr
                    key={c.id}
                    data-testid={`org-contacts-row-${c.id}`}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{c.name ?? '—'}</span>
                      {c.isPrimary && (
                        <span
                          data-testid={`org-contacts-primary-${c.id}`}
                          className="ml-2 inline-flex rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary"
                        >
                          {c.siteId === null
                            ? t('contactsCard.primary.organization')
                            : t('contactsCard.primary.site', {
                                site: pinned ?? t('contactsCard.unknownSite'),
                              })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <div>{c.email ?? '—'}</div>
                      <div>{c.phone ?? c.mobile ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{c.title ?? '—'}</td>
                    <td className="px-3 py-2" data-testid={`org-contacts-roles-${c.id}`}>
                      {c.roles.length === 0 ? '—' : (
                        <span className="flex flex-wrap gap-1">
                          {c.roles.map((role) => (
                            <span
                              key={role}
                              className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-xs"
                            >
                              {isKnownRole(role)
                                ? t(/* i18n-dynamic */ ROLE_LABEL_KEYS[role])
                                : role}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground" data-testid={`org-contacts-site-${c.id}`}>
                      {c.siteId === null
                        ? t('contactsCard.organizationLevel')
                        : (pinned ?? t('contactsCard.unknownSite'))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        data-testid={`org-contacts-edit-${c.id}`}
                        onClick={() => openEdit(c)}
                        className="rounded-md px-2 py-1 text-xs underline hover:bg-muted"
                      >
                        {t('contactsCard.actions.edit')}
                      </button>
                      <button
                        type="button"
                        data-testid={`org-contacts-delete-${c.id}`}
                        onClick={() => void remove(c)}
                        disabled={deletingId !== null}
                        className="ml-1 rounded-md px-2 py-1 text-xs text-destructive underline hover:bg-muted disabled:opacity-50"
                      >
                        {t('contactsCard.actions.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loadError && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span data-testid="org-contacts-page">
            {t('contactsCard.pagination.summary', { from: rangeFrom, to: rangeTo, total })}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              data-testid="org-contacts-prev"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
            >
              {t('contactsCard.pagination.previous')}
            </button>
            <button
              type="button"
              data-testid="org-contacts-next"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
            >
              {t('contactsCard.pagination.next')}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
