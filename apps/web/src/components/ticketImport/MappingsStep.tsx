import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { PARTNER_WIDE, readImport, type ImportSourceDetail, type Preflight } from './ticketImportApi';
import { runPreflight } from './PreflightStep';
import { Notice, Panel, buttonPrimary, importFriendly, inputClass, labelClass } from './importUi';
import { usePartnerOrgs } from './usePartnerOrgs';

/**
 * Step 3, Mappings (#8313 W6; spec 2026-10-19 §5.11 step 3, §5.13, §6.3,
 * §6.4): each source org to a Breeze org or "skip", one optional fallback
 * org, groups to categories (default none), priorities, states and the
 * module options, among them "Create missing requester contacts" (off by
 * default) with its optional "only for tickets updated since".
 *
 * Saved with PUT /sources/:id/mappings, which replaces the maps and the
 * options; owner-only, and refused while a run is active. The options form is
 * Zammad's (the only module); its option names are the module's schema
 * (services/ticketImport/modules/zammad/options.ts).
 */
type Props = {
  source: ImportSourceDetail;
  preflight: Preflight | null;
  onPreflight: (result: Preflight) => void;
  onSaved: () => void;
  onContinue: () => void;
};

export const TARGET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type TargetPriority = (typeof TARGET_PRIORITIES)[number];
export const TARGET_STATUSES = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] as const;
type TargetStatus = (typeof TARGET_STATUSES)[number];

/** The module's default for a priority with no entry (§6.3): by its seeded name, anything else normal. */
export function defaultPriority(name: string): TargetPriority {
  const n = name.toLowerCase();
  if (/\blow\b/.test(n)) return 'low';
  if (/\bhigh\b/.test(n)) return 'high';
  return 'normal';
}

type Form = {
  orgs: Record<string, string>; // source org key -> org id, '' = skip
  /** Saved maps of source orgs the catalog no longer lists, by key, with their saved name: kept unless removed. */
  goneOrgs: Record<string, string>;
  fallbackOrgId: string;
  categories: Record<string, string>; // source group key -> category id, '' = none
  priorities: Record<string, TargetPriority>;
  states: Record<string, TargetStatus | ''>; // '' = by state type
  systemArticles: 'skip' | 'internal_note';
  timeAccountingNote: boolean;
  timeUnitLabel: string;
  createRequesterContacts: boolean;
  createRequesterContactsUpdatedSince: string;
};

function initialForm(source: ImportSourceDetail, preflight: Preflight, orgs: Array<{ id: string; name: string }>): Form {
  const opts = source.options as Record<string, unknown>;
  const savedOrgs = source.mappings.orgs;
  const byName = new Map(orgs.map((o) => [o.name.trim().toLowerCase(), o.id]));
  const orgMap: Record<string, string> = {};
  for (const entry of preflight.catalog.orgs) {
    const saved = savedOrgs.find((m) => m.sourceOrgKey === entry.key);
    // With nothing saved yet, an org whose name matches exactly is suggested.
    orgMap[entry.key] = saved ? saved.orgId : savedOrgs.length === 0 ? (byName.get(entry.name.trim().toLowerCase()) ?? '') : '';
  }
  // A saved map of an org the source no longer lists (deleted, or hidden from
  // the token) is kept: its tickets may still be in the ledger.
  const goneOrgs: Record<string, string> = {};
  const listed = new Set(preflight.catalog.orgs.map((o) => o.key));
  for (const saved of savedOrgs) {
    if (saved.sourceOrgKey === null || listed.has(saved.sourceOrgKey)) continue;
    orgMap[saved.sourceOrgKey] = saved.orgId;
    goneOrgs[saved.sourceOrgKey] = saved.sourceOrgName ?? saved.sourceOrgKey;
  }
  const categories: Record<string, string> = {};
  for (const group of preflight.catalog.groups) {
    categories[group.key] = source.mappings.categories.find((m) => m.sourceGroupKey === group.key)?.categoryId ?? '';
  }
  const savedPriorities = (opts.priorityMap ?? {}) as Record<string, TargetPriority>;
  const priorities: Record<string, TargetPriority> = {};
  for (const p of preflight.catalog.priorities) priorities[p.key] = savedPriorities[p.key] ?? defaultPriority(p.name);
  const savedStates = (opts.stateMap ?? {}) as Record<string, { status: TargetStatus }>;
  const states: Record<string, TargetStatus | ''> = {};
  for (const s of preflight.catalog.states) states[s.key] = savedStates[s.key]?.status ?? '';
  return {
    orgs: orgMap,
    goneOrgs,
    fallbackOrgId: savedOrgs.find((m) => m.sourceOrgKey === null)?.orgId ?? '',
    categories,
    priorities,
    states,
    systemArticles: opts.systemArticles === 'internal_note' ? 'internal_note' : 'skip',
    timeAccountingNote: opts.timeAccountingNote !== false,
    timeUnitLabel: typeof opts.timeUnitLabel === 'string' ? opts.timeUnitLabel : 'minutes',
    createRequesterContacts: opts.createRequesterContacts === true,
    createRequesterContactsUpdatedSince: typeof opts.createRequesterContactsUpdatedSince === 'string' ? opts.createRequesterContactsUpdatedSince : '',
  };
}

/** The PUT body: every map row and the whole options object (the route replaces both). */
export function mappingsBody(source: ImportSourceDetail, preflight: Preflight, form: Form) {
  const orgName = new Map(preflight.catalog.orgs.map((o) => [o.key, o.name]));
  const groupName = new Map(preflight.catalog.groups.map((g) => [g.key, g.name]));
  const stateName = new Map(preflight.catalog.states.map((s) => [s.key, s.name]));
  const orgs: Array<{ sourceOrgKey: string | null; sourceOrgName: string | null; orgId: string }> = Object.entries(form.orgs)
    .filter(([, orgId]) => orgId !== '')
    .map(([key, orgId]) => ({ sourceOrgKey: key, sourceOrgName: (orgName.get(key) ?? form.goneOrgs[key] ?? '').slice(0, 255) || null, orgId }));
  if (form.fallbackOrgId) orgs.push({ sourceOrgKey: null, sourceOrgName: null, orgId: form.fallbackOrgId });
  const categories = Object.entries(form.categories)
    .filter(([, categoryId]) => categoryId !== '')
    .map(([key, categoryId]) => ({ sourceGroupKey: key, sourceGroupName: (groupName.get(key) ?? '').slice(0, 255) || null, categoryId }));
  const stateMap: Record<string, { status: TargetStatus; name?: string }> = {};
  for (const [key, status] of Object.entries(form.states)) {
    if (!status) continue;
    // eslint-disable-next-line no-control-regex
    const name = (stateName.get(key) ?? '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 255);
    stateMap[key] = name ? { status, name } : { status };
  }
  const options: Record<string, unknown> = {
    ...source.options,
    priorityMap: form.priorities,
    stateMap,
    systemArticles: form.systemArticles,
    timeAccountingNote: form.timeAccountingNote,
    timeUnitLabel: form.timeUnitLabel.trim() || 'minutes',
    createRequesterContacts: form.createRequesterContacts,
  };
  if (form.createRequesterContacts && form.createRequesterContactsUpdatedSince) {
    options.createRequesterContactsUpdatedSince = form.createRequesterContactsUpdatedSince;
  } else {
    delete options.createRequesterContactsUpdatedSince;
  }
  return { orgs, categories, options };
}

export default function MappingsStep({ source, preflight, onPreflight, onSaved, onContinue }: Props) {
  const { t } = useTranslation('ticketImport');
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const isOwner = userId !== null && source.ownerUserId === userId;
  const locked = source.activeRunId !== null;
  const { orgs } = usePartnerOrgs();
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readImport<Array<{ id: string; name: string; isActive?: boolean }>>('/ticket-categories')
      .then(({ data }) => { if (!cancelled) setCategories(data.filter((c) => c.isActive !== false)); })
      .catch(() => { if (!cancelled) setCategories([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (preflight) setForm(initialForm(source, preflight, orgs));
    // Re-seed only when the source or its catalog changes, not on every org-store refresh.
  }, [source.id, source.updatedAt, preflight, orgs.length]);

  const loadCatalog = async () => {
    setLoadingCatalog(true);
    const result = await runPreflight(source.id, t);
    setLoadingCatalog(false);
    if (result) onPreflight(result);
  };

  const mappedCount = useMemo(() => (form ? Object.entries(form.orgs).filter(([key, orgId]) => orgId && !(key in form.goneOrgs)).length : 0), [form]);
  const editable = isOwner && !locked;

  if (!preflight || !form) {
    return (
      <Panel title={t('mappings.title')} testId="ticket-import-mappings">
        <Notice testId="ticket-import-mappings-needs-preflight">{t('mappings.needsPreflight')}</Notice>
        <button type="button" className={`${buttonPrimary} mt-3`} onClick={() => void loadCatalog()}
          disabled={loadingCatalog || !source.hasCredentials} data-testid="ticket-import-mappings-load">
          {loadingCatalog ? t('preflight.running') : t('preflight.run')}
        </button>
      </Panel>
    );
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const setIn = (key: 'orgs' | 'categories' | 'priorities' | 'states', sub: string, value: string) =>
    setForm((f) => (f ? { ...f, [key]: { ...f[key], [sub]: value } } : f));

  const save = async (andContinue: boolean) => {
    if (!editable) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-imports/sources/${source.id}/mappings`, {
          ...PARTNER_WIDE,
          method: 'PUT',
          body: JSON.stringify(mappingsBody(source, preflight, form)),
        }),
        errorFallback: t('mappings.saveFailed'),
        friendly: importFriendly(t),
        successMessage: t('mappings.saved'),
      });
      onSaved();
      if (andContinue) onContinue();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('mappings.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const orgOptions = (
    <>
      {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </>
  );

  return (
    <Panel title={t('mappings.title')} testId="ticket-import-mappings">
      <p className="mb-4 text-sm text-muted-foreground">{t('mappings.intro')}</p>
      {!isOwner && <div className="mb-4"><Notice testId="ticket-import-mappings-not-owner">{t('mappings.notOwner')}</Notice></div>}
      {locked && <div className="mb-4"><Notice tone="warning" testId="ticket-import-mappings-locked">{t('mappings.locked')}</Notice></div>}

      <fieldset disabled={!editable} className="space-y-6">
        <section data-testid="ticket-import-mappings-orgs">
          <h3 className="mb-1 text-sm font-semibold">{t('mappings.orgsTitle')}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{t('mappings.orgsHelp', { mapped: mappedCount, total: preflight.catalog.orgs.length })}</p>
          <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
            {preflight.catalog.orgs.map((entry) => (
              <label key={entry.key} className="grid items-center gap-2 text-sm sm:grid-cols-2">
                <span className="truncate" title={entry.name}>{entry.name}{entry.active === false ? ` (${t('mappings.inactive')})` : ''}</span>
                <select className={inputClass} value={form.orgs[entry.key] ?? ''} onChange={(e) => setIn('orgs', entry.key, e.target.value)}
                  data-testid={`ticket-import-mappings-org-${entry.key}`}>
                  <option value="">{t('mappings.skip')}</option>
                  {orgOptions}
                </select>
              </label>
            ))}
          </div>
          {Object.keys(form.goneOrgs).length > 0 && (
            <div className="mt-3 space-y-1" data-testid="ticket-import-mappings-gone-orgs">
              <p className="text-xs text-muted-foreground">{t('mappings.goneOrgsHelp')}</p>
              {Object.entries(form.goneOrgs).map(([key, name]) => (
                <label key={key} className="grid items-center gap-2 text-sm sm:grid-cols-2">
                  <span className="truncate" title={name}>{name} ({t('mappings.goneOrg')})</span>
                  <select className={inputClass} value={form.orgs[key] ?? ''} onChange={(e) => setIn('orgs', key, e.target.value)}
                    data-testid={`ticket-import-mappings-org-${key}`}>
                    <option value="">{t('mappings.removeMap')}</option>
                    {orgOptions}
                  </select>
                </label>
              ))}
            </div>
          )}
          <label className={`${labelClass} mt-3`}>
            {t('mappings.fallback')}
            <select className={`${inputClass} mt-1`} value={form.fallbackOrgId} onChange={(e) => set('fallbackOrgId', e.target.value)}
              data-testid="ticket-import-mappings-fallback">
              <option value="">{t('mappings.noFallback')}</option>
              {orgOptions}
            </select>
            <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('mappings.fallbackHelp')}</span>
          </label>
        </section>

        <section data-testid="ticket-import-mappings-groups">
          <h3 className="mb-1 text-sm font-semibold">{t('mappings.groupsTitle')}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{t('mappings.groupsHelp')}</p>
          {preflight.catalog.groups.map((group) => (
            <label key={group.key} className="mb-1 grid items-center gap-2 text-sm sm:grid-cols-2">
              <span className="truncate">{group.name}{group.active === false ? ` (${t('mappings.inactive')})` : ''}</span>
              <select className={inputClass} value={form.categories[group.key] ?? ''} onChange={(e) => setIn('categories', group.key, e.target.value)}
                data-testid={`ticket-import-mappings-group-${group.key}`}>
                <option value="">{t('mappings.noCategory')}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ))}
        </section>

        <section data-testid="ticket-import-mappings-priorities">
          <h3 className="mb-2 text-sm font-semibold">{t('mappings.prioritiesTitle')}</h3>
          {preflight.catalog.priorities.map((p) => (
            <label key={p.key} className="mb-1 grid items-center gap-2 text-sm sm:grid-cols-2">
              <span>{p.name}</span>
              <select className={inputClass} value={form.priorities[p.key] ?? 'normal'} onChange={(e) => setIn('priorities', p.key, e.target.value)}
                data-testid={`ticket-import-mappings-priority-${p.key}`}>
                {TARGET_PRIORITIES.map((value) => <option key={value} value={value}>{t(/* i18n-dynamic */ `mappings.priority.${value}`)}</option>)}
              </select>
            </label>
          ))}
        </section>

        <section data-testid="ticket-import-mappings-states">
          <h3 className="mb-1 text-sm font-semibold">{t('mappings.statesTitle')}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{t('mappings.statesHelp')}</p>
          {preflight.catalog.states.map((s) => (
            <label key={s.key} className="mb-1 grid items-center gap-2 text-sm sm:grid-cols-2">
              <span>{s.name}</span>
              <select className={inputClass} value={form.states[s.key] ?? ''} onChange={(e) => setIn('states', s.key, e.target.value)}
                data-testid={`ticket-import-mappings-state-${s.key}`}>
                <option value="">{t('mappings.stateByType')}</option>
                {TARGET_STATUSES.map((value) => <option key={value} value={value}>{t(/* i18n-dynamic */ `mappings.status.${value}`)}</option>)}
              </select>
            </label>
          ))}
        </section>

        <section className="space-y-3" data-testid="ticket-import-mappings-options">
          <h3 className="text-sm font-semibold">{t('mappings.optionsTitle')}</h3>
          <div className="rounded-md border p-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={form.createRequesterContacts}
                onChange={(e) => set('createRequesterContacts', e.target.checked)} data-testid="ticket-import-mappings-create-contacts" />
              <span>
                <span className="font-medium">{t('mappings.createContacts')}</span>
                <span className="block text-xs text-muted-foreground">{t('mappings.createContactsHelp')}</span>
              </span>
            </label>
            {form.createRequesterContacts && (
              <label className={`${labelClass} mt-3 sm:w-64`}>
                {t('mappings.updatedSince')}
                <input type="date" className={`${inputClass} mt-1`} value={form.createRequesterContactsUpdatedSince}
                  onChange={(e) => set('createRequesterContactsUpdatedSince', e.target.value)} data-testid="ticket-import-mappings-updated-since" />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('mappings.updatedSinceHelp')}</span>
              </label>
            )}
          </div>
          <label className={`${labelClass} sm:w-80`}>
            {t('mappings.systemArticles')}
            <select className={`${inputClass} mt-1`} value={form.systemArticles}
              onChange={(e) => set('systemArticles', e.target.value === 'internal_note' ? 'internal_note' : 'skip')}
              data-testid="ticket-import-mappings-system-articles">
              <option value="skip">{t('mappings.systemArticlesSkip')}</option>
              <option value="internal_note">{t('mappings.systemArticlesNote')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.timeAccountingNote} onChange={(e) => set('timeAccountingNote', e.target.checked)}
              data-testid="ticket-import-mappings-time-note" />
            {t('mappings.timeAccountingNote')}
          </label>
          {form.timeAccountingNote && (
            <label className={`${labelClass} sm:w-64`}>
              {t('mappings.timeUnitLabel')}
              <input className={`${inputClass} mt-1`} maxLength={32} value={form.timeUnitLabel}
                onChange={(e) => set('timeUnitLabel', e.target.value)} data-testid="ticket-import-mappings-time-unit" />
            </label>
          )}
        </section>
      </fieldset>

      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" className={buttonPrimary} disabled={!editable || saving} onClick={() => void save(true)}
          data-testid="ticket-import-mappings-save">
          {saving ? t('mappings.saving') : t('mappings.saveAndContinue')}
        </button>
        {!editable && (
          <button type="button" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={onContinue}
            data-testid="ticket-import-mappings-continue">{t('common.continue')}</button>
        )}
      </div>
    </Panel>
  );
}
