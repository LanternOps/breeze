import '@/lib/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryBlockDto } from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useAiStore } from '../../stores/aiStore';
import { getJwtClaims } from '../../lib/authScope';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { asList } from '@/lib/asList';
import { useHashState } from '@/lib/useHashState';

type TabId = 'mine' | 'org' | 'partner' | 'users';
type UserOption = { id: string; name?: string; email?: string };

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

const STATUS_PILL: Record<MemoryBlockDto['status'], string> = {
  unconfirmed: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  confirmed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  retracted: 'bg-muted text-muted-foreground',
};

const parseHashTab = (hash: string): TabId | undefined => {
  const id = /(?:^|&)tab=([a-z]+)/.exec(hash)?.[1];
  return id === 'mine' || id === 'org' || id === 'partner' || id === 'users' ? id : undefined;
};

/**
 * Wisp memory (W03): review what Wisp remembered and confirm or retract it.
 * Block content is rendered as inert pretty-printed JSON inside <pre>; it is
 * never interpreted, linked, or rendered as markup.
 */
export default function WispMemoryPage() {
  const { t } = useTranslation('settings');
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) === true;
  const organizations = useOrgStore((s) => s.organizations);
  // UX only; the API re-checks. Undecodable token ⇒ treat as partner (server decides).
  const scope = getJwtClaims().scope;
  const showPartnerTab = scope === null || scope === 'partner';

  const tabs = useMemo(() => {
    const list: TabId[] = ['mine', 'org'];
    if (showPartnerTab) list.push('partner');
    if (canManagePartnerWide) list.push('users');
    return list;
  }, [showPartnerTab, canManagePartnerWide]);

  const [tab, setTabState] = useHashState<TabId>('mine', parseHashTab);
  const activeTab: TabId = tabs.includes(tab) ? tab : 'mine';
  const [orgId, setOrgId] = useState('');
  const [userId, setUserId] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [usersError, setUsersError] = useState(false);
  const [blocks, setBlocks] = useState<MemoryBlockDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const setTab = (next: TabId) => {
    setTabState(next);
    window.location.hash = `tab=${next}`;
  };

  useEffect(() => {
    if (activeTab !== 'users' || users.length > 0) return;
    let live = true;
    setUsersError(false);
    void fetchWithAuth('/users')
      .then(async (response) => {
        if (response.status === 401) {
          UNAUTHORIZED();
          return;
        }
        if (!response.ok) throw new Error(`GET /users failed (${response.status})`);
        const data = await response.json();
        if (live) setUsers(asList(data, 'users') as UserOption[]);
      })
      .catch((error: unknown) => {
        // Without this an empty picker reads as "no colleagues" rather than "failed to load".
        console.error('[WispMemoryPage] user list failed', error);
        if (live) setUsersError(true);
      });
    return () => {
      live = false;
    };
  }, [activeTab, users.length]);

  const listUrl = useMemo<string | null>(() => {
    if (activeTab === 'mine') return '/wisp/memory?scope=mine';
    if (activeTab === 'partner') return '/wisp/memory?scope=partner';
    if (activeTab === 'org') return orgId ? `/wisp/memory?scope=org&orgId=${encodeURIComponent(orgId)}` : null;
    return userId ? `/wisp/memory/users/${encodeURIComponent(userId)}` : null;
  }, [activeTab, orgId, userId]);

  const load = useCallback(async () => {
    if (!listUrl) {
      setBlocks([]);
      setLoading(false);
      setLoadError(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetchWithAuth(listUrl);
      if (response.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!response.ok) throw new Error('load failed');
      const body = (await response.json()) as { blocks?: MemoryBlockDto[] };
      setBlocks(body.blocks ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [listUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (block: MemoryBlockDto, action: 'confirm' | 'retract') => {
    const failed = t(/* i18n-dynamic */ action === 'confirm' ? 'wispMemory.confirmFailed' : 'wispMemory.retractFailed');
    setBusyId(block.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/wisp/memory/${block.id}/${action}`, { method: 'POST' }),
        errorFallback: failed,
        successMessage: t(/* i18n-dynamic */ action === 'confirm' ? 'wispMemory.confirmed' : 'wispMemory.retracted'),
        onUnauthorized: UNAUTHORIZED,
      });
      await load();
    } catch (error) {
      handleActionError(error, failed);
      // 404 (gone) / 409 (retracted or superseded meanwhile): the row is stale — reload so it stops offering actions.
      if (error instanceof ActionError && (error.status === 404 || error.status === 409)) void load();
    } finally {
      setBusyId(null);
    }
  };

  const openConversation = async (sessionId: string) => {
    try {
      await useAiStore.getState().loadSession(sessionId);
    } catch (error) {
      console.error('[WispMemoryPage] loadSession failed', error);
    }
    // loadSession clears the session on a 404 (erased or expired) without raising;
    // opening then would show an empty panel with no explanation.
    if (useAiStore.getState().sessionId !== sessionId) {
      showToast({ type: 'error', message: t('wispMemory.conversationUnavailable') });
      return;
    }
    useAiStore.getState().open();
  };

  const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('wispMemory.title')}</h1>
        <p className="text-muted-foreground">{t('wispMemory.description')}</p>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            data-testid={`wisp-memory-tab-${id}`}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              activeTab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(/* i18n-dynamic */ `wispMemory.tabs.${id}`)}
          </button>
        ))}
      </div>

      {activeTab === 'org' && (
        <select
          data-testid="wisp-memory-org-picker"
          aria-label={t('wispMemory.pickOrg')}
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className={selectClass}
        >
          <option value="">{t('wispMemory.pickOrg')}</option>
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      )}
      {activeTab === 'users' && (
        <select
          data-testid="wisp-memory-user-picker"
          aria-label={t('wispMemory.pickUser')}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className={selectClass}
        >
          <option value="">{t('wispMemory.pickUser')}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name || user.email || user.id}
            </option>
          ))}
        </select>
      )}
      {activeTab === 'users' && usersError && (
        <p data-testid="wisp-memory-users-error" className="text-sm text-destructive">{t('wispMemory.usersLoadFailed')}</p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="mt-4 text-sm text-muted-foreground">{t('wispMemory.loading')}</p>
          </div>
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{t('wispMemory.loadFailed')}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('wispMemory.retry')}
          </button>
        </div>
      ) : !listUrl ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('wispMemory.pickPrompt')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="min-w-full divide-y" data-testid="wisp-memory-table">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('wispMemory.columns.subject')}</th>
                <th className="px-4 py-3">{t('wispMemory.columns.type')}</th>
                <th className="px-4 py-3">{t('wispMemory.columns.status')}</th>
                <th className="px-4 py-3">{t('wispMemory.columns.confidence')}</th>
                <th className="px-4 py-3">{t('wispMemory.columns.updated')}</th>
                <th className="px-4 py-3 text-right">{t('wispMemory.columns.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {blocks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {t('wispMemory.empty')}
                  </td>
                </tr>
              ) : (
                blocks.map((block) => (
                  <tr
                    key={block.id}
                    data-testid={`wisp-memory-row-${block.id}`}
                    data-status={block.status}
                    className={block.status === 'retracted' ? 'opacity-50' : 'transition hover:bg-muted/40'}
                  >
                    <td className="px-4 py-3 align-top text-sm">
                      <div className="font-medium">{block.subjectKey}</div>
                      <button
                        type="button"
                        data-testid={`wisp-memory-toggle-${block.id}`}
                        onClick={() => setExpanded((prev) => ({ ...prev, [block.id]: !prev[block.id] }))}
                        className="mt-1 text-xs text-primary hover:underline"
                      >
                        {expanded[block.id] ? t('wispMemory.hideContent') : t('wispMemory.showContent')}
                      </button>
                      {expanded[block.id] && (
                        <pre
                          data-testid={`wisp-memory-content-${block.id}`}
                          className="mt-2 max-h-64 max-w-md overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-xs"
                        >
                          {JSON.stringify(block.content, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-sm">{t(/* i18n-dynamic */ `wispMemory.type.${block.blockType}`)}</td>
                    <td className="px-4 py-3 align-top text-sm">
                      <span
                        data-testid={`wisp-memory-status-${block.id}`}
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[block.status]}`}
                      >
                        {t(/* i18n-dynamic */ `wispMemory.statusValue.${block.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top text-sm text-muted-foreground">
                      {t(/* i18n-dynamic */ `wispMemory.confidenceValue.${block.confidence}`)}
                    </td>
                    <td className="px-4 py-3 align-top text-sm text-muted-foreground">
                      {formatDateTime(block.updatedAt)}
                    </td>
                    <td className="px-4 py-3 align-top text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {block.sourceSessionId && (
                          <button
                            type="button"
                            data-testid="wisp-memory-from-conversation"
                            onClick={() => void openConversation(block.sourceSessionId as string)}
                            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                          >
                            {t('wispMemory.fromConversation')}
                          </button>
                        )}
                        {block.status === 'unconfirmed' && (
                          <button
                            type="button"
                            data-testid={`wisp-memory-confirm-${block.id}`}
                            disabled={busyId === block.id}
                            onClick={() => void mutate(block, 'confirm')}
                            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                          >
                            {t('wispMemory.confirm')}
                          </button>
                        )}
                        {block.status !== 'retracted' && (
                          <button
                            type="button"
                            data-testid={`wisp-memory-retract-${block.id}`}
                            disabled={busyId === block.id}
                            onClick={() => void mutate(block, 'retract')}
                            className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                          >
                            {t('wispMemory.retract')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
