import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PARTNER_LEVEL_ENTITY_KINDS, WISP_ENTITY_KINDS, type WispEntityKind, type WispThreadLink } from '@breeze/shared';
import { Dialog } from '@/components/shared/Dialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import { hasPermission } from '@/lib/permissions';
import { addWispLink } from '@/lib/wispLinksApi';
import { fetchWithAuth, useAuthStore, type Permission } from '@/stores/auth';
import { filterRows, linkKey, WISP_ENTITY_SOURCES, type PickerRow } from './wispEntitySources';

export type WispEntityPickerProps = {
  open: boolean;
  threadId: string;
  /** `linkKey(kind, id)` of everything already on the thread. */
  linkedKeys: ReadonlySet<string>;
  onClose: () => void;
  /** Called with the stored link; the parent decides whether to close. */
  onLinked: (link: WispThreadLink) => void;
};

const SEARCH_DEBOUNCE_MS = 250;

/**
 * #10113: whether the caller may pick partner-level kinds (users). Their list,
 * `GET /users`, is partner-wide user management: the users route 403s a partner
 * user without orgAccess 'all', and requires users:read. The grant ceiling
 * refuses a partner-level link under the same orgAccess condition, so an
 * org-restricted user could not link a user even with a list. `canManagePartnerWide`
 * is that orgAccess bit from /users/me; absent (a session from before the field)
 * reads as "no" — a missing tab beats a tab that always fails. UX only: the
 * server enforces both checks regardless.
 */
function canPickPartnerLevel(user: { permissions?: Permission[]; canManagePartnerWide?: boolean } | null | undefined): boolean {
  return user?.canManagePartnerWide === true && hasPermission(user.permissions, 'users', 'read');
}

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: PickerRow[] };

/**
 * "Link an item to Wisp": pick a Breeze object from its kind's normal list.
 * Reads go through the org switcher like the list pages themselves (no
 * `skipOrgIdInjection`), so the candidates match what the user is looking at;
 * the add is grant-addressed and the server re-reads the org from the entity.
 */
export default function WispEntityPicker({ open, threadId, linkedKeys, onClose, onLinked }: WispEntityPickerProps) {
  const { t } = useTranslation('ai');
  const titleId = useId();
  const partnerLevelAllowed = useAuthStore((s) => canPickPartnerLevel(s.user));
  const kinds = useMemo(
    () => WISP_ENTITY_KINDS.filter((k) => partnerLevelAllowed || !PARTNER_LEVEL_ENTITY_KINDS.has(k)),
    [partnerLevelAllowed],
  );
  const [selectedKind, setKind] = useState<WispEntityKind>('ticket');
  // A tab that disappears while selected (access dropped mid-dialog) falls back to Tickets.
  const kind: WispEntityKind = kinds.includes(selectedKind) ? selectedKind : 'ticket';
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [linking, setLinking] = useState(false);
  const requestToken = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const source = WISP_ENTITY_SOURCES[kind];
  // Client-filtered kinds ignore the search in the URL, so typing never re-fetches them.
  const url = source.listUrl(source.serverSearch ? debounced : '');

  useEffect(() => {
    if (!open) return;
    const token = ++requestToken.current;
    // Only the newest request may commit: a slow earlier search, or the
    // previous kind's list, must never overwrite what the user now asked for.
    const current = () => live.current && token === requestToken.current;
    setList({ status: 'loading' });
    (async () => {
      try {
        const res = await fetchWithAuth(url);
        if (!res.ok) throw new Error(`${url} → ${res.status}`);
        const rows = source.rows(await res.json());
        if (current()) setList({ status: 'ready', rows });
      } catch (err) {
        if (!current()) return;
        console.error('[WispEntityPicker] list load failed', err);
        setList({ status: 'failed' });
      }
    })();
  }, [open, url, source]);

  // A reopened picker starts on Tickets with an empty search, like a fresh one.
  useEffect(() => {
    if (open) return;
    setKind('ticket');
    setSearch('');
    setDebounced('');
  }, [open]);

  const select = async (row: PickerRow) => {
    if (linking) return;
    setLinking(true);
    try {
      const link = await addWispLink(threadId, { kind: row.kind, id: row.id, orgId: row.orgId });
      onLinked(link);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        console.error('[WispEntityPicker] link failed', err);
        showToast({ type: 'error', message: t('wisp.links.addFailed') }); // ActionError already toasted
      }
    } finally {
      if (live.current) setLinking(false);
    }
  };

  const shown = list.status === 'ready' ? (source.serverSearch ? list.rows : filterRows(list.rows, search)) : [];

  return (
    <Dialog open={open} onClose={onClose} title={t('wisp.picker.title')} labelledBy={titleId} maxWidth="2xl" className="flex max-h-[85vh] flex-col p-5">
      <div data-testid="wisp-entity-picker" className="flex min-h-0 flex-1 flex-col gap-3">
        <h2 id={titleId} className="text-base font-semibold">{t('wisp.picker.title')}</h2>

        <input
          type="search"
          data-testid="wisp-picker-search"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          placeholder={t('wisp.picker.searchPlaceholder')}
          aria-label={t('wisp.picker.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div role="tablist" aria-label={t('wisp.picker.kindsLabel')} className="flex flex-wrap gap-1">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === kind}
              data-testid={`wisp-picker-kind-${k}`}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                k === kind ? 'bg-primary text-primary-foreground' : 'border text-muted-foreground hover:bg-muted'
              }`}
              onClick={() => setKind(k)}
            >
              {t(/* i18n-dynamic */ `wisp.picker.kinds.${k}`)}
            </button>
          ))}
        </div>

        <div className="min-h-[12rem] flex-1 overflow-y-auto rounded-md border" aria-busy={list.status === 'loading'}>
          {list.status === 'loading' ? (
            <p data-testid="wisp-picker-loading" className="p-4 text-sm text-muted-foreground">{t('wisp.picker.loading')}</p>
          ) : list.status === 'failed' ? (
            <p data-testid="wisp-picker-error" role="alert" className="p-4 text-sm text-destructive">{t('wisp.picker.loadFailed')}</p>
          ) : shown.length === 0 ? (
            <p data-testid="wisp-picker-empty" className="p-4 text-sm text-muted-foreground">{t('wisp.picker.empty')}</p>
          ) : (
            <ul className="divide-y">
              {shown.map((row) => {
                const linked = linkedKeys.has(linkKey(row.kind, row.id));
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`wisp-picker-row-${row.kind}-${row.id}`}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                      disabled={linked || linking}
                      onClick={() => void select(row)}
                    >
                      <span className="min-w-0 truncate">{row.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {linked ? t('wisp.picker.alreadyLinked') : row.status}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={onClose} data-testid="wisp-picker-close">
            {t('wisp.picker.close')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
