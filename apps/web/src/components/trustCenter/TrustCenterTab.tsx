import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getTrustControls, getTrustPage, type TrustControlsState, type TrustPageDraft, type TrustPageState } from '@/lib/api/trustPage';
import { usePermissions } from '@/lib/permissions';
import { useLatest, type OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import TrustBadgeSnippet from './TrustBadgeSnippet';
import TrustContentSection from './TrustContentSection';
import TrustControlsSection from './TrustControlsSection';
import TrustDocumentsSection from './TrustDocumentsSection';
import TrustStatusCard from './TrustStatusCard';

type LoadState = { failed: true } | { page: TrustPageState; controls: TrustControlsState | null } | null;

/**
 * The organization record's Trust Center tab (#8768 W1). Owns data loading and
 * the write gate: the tab is visible with organizations:read, every mutation is
 * disabled unless organizations:write (plan 19.12).
 */
export default function TrustCenterTab({ orgId, orgFetch }: { orgId: string; orgFetch: OrgFetch }) {
  const { t } = useTranslation('organizations');
  const { can } = usePermissions();
  const canWrite = can('organizations', 'write');
  const [state, setState] = useState<LoadState>(null);
  const latest = useLatest<LoadState>();
  const tr = useCallback(
    (key: string) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`),
    [t],
  );

  const load = useCallback(async () => {
    const result = await latest.run(
      (async (): Promise<LoadState> => {
        const page = await getTrustPage(orgFetch, orgId);
        // Controls are a secondary read: the status card must work without them.
        const controls = await getTrustControls(orgFetch, orgId).catch((err: unknown) => {
          console.error('[TrustCenterTab] failed to load controls', err);
          return null;
        });
        return { page, controls };
      })().catch((err: unknown): LoadState => {
        console.error('[TrustCenterTab] failed to load trust page', err);
        return { failed: true };
      }),
    );
    if (result !== undefined) setState(result);
  }, [latest, orgFetch, orgId]);

  useEffect(() => {
    setState(null);
    void load();
  }, [load]);

  const onPageChange = useCallback((page: TrustPageDraft) => {
    setState((prev) => (prev && 'page' in prev ? { ...prev, page: { ...prev.page, page } } : prev));
  }, []);

  if (state === null) {
    return <div className="p-6 text-sm text-muted-foreground" data-testid="trust-loading">{tr('loading')}</div>;
  }
  if ('failed' in state) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm" role="alert" data-testid="trust-load-error">
        <p>{tr('loadFailed')}</p>
        <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 hover:bg-muted" data-testid="trust-retry">
          {tr('retry')}
        </button>
      </div>
    );
  }

  const { page } = state;
  return (
    <div className="space-y-4" data-testid="trust-center-tab">
      <TrustStatusCard
        orgId={orgId}
        orgFetch={orgFetch}
        state={page}
        canWrite={canWrite}
        onPageChange={onPageChange}
        onReload={load}
      />
      <TrustControlsSection orgId={orgId} orgFetch={orgFetch} state={page} controls={state.controls} canWrite={canWrite} onReload={load} />
      <TrustContentSection orgId={orgId} orgFetch={orgFetch} page={page.page} canWrite={canWrite} onReload={load} />
      {/* W1 follow-up: the GET state carries no linked documents (A2 lacks a read endpoint), so links start empty. */}
      <TrustDocumentsSection orgId={orgId} orgFetch={orgFetch} canWrite={canWrite} initialLinks={[]} onReload={load} />
      <TrustBadgeSnippet publicPath={page.publicPath} badgePath={page.badgePath} published={page.page.publishedAt !== null} />
    </div>
  );
}
