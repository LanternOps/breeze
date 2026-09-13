import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity as ActivityIcon,
  AlertCircle,
  Building2,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  MapPin,
  Monitor,
  Receipt,
  Ticket,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OverflowTabs, type OverflowTab } from '@/components/shared/OverflowTabs';
import ArchiveOrgModal from '@/components/settings/ArchiveOrgModal';
import MergeOrgModal from '@/components/settings/MergeOrgModal';
import { statusLabelKeys } from '@/lib/orgStatus';
import { isArchiveLifecycleOrg } from '@/lib/archiveLifecycle';
import { useJwtClaims } from '@/lib/authScope';
import { formatDate } from '@/lib/dateTimeFormat';
import { navigateTo } from '@/lib/navigation';
import { applyOrgSwitch } from '@/lib/orgSwitch';
import { usePermissions } from '@/lib/permissions';
import { runAction, ActionError } from '@/lib/runAction';
import { useHashState } from '@/lib/useHashState';
import { useOrgStore, type Organization } from '@/stores/orgStore';
import ContactsCard from '@/components/settings/ContactsCard';
import OrgActivityTab from './OrgActivityTab';
import OrgBillingTab from './OrgBillingTab';
import OrgDevicesTab from './OrgDevicesTab';
import OrgOverviewTab from './OrgOverviewTab';
import OrgRecordHeader from './OrgRecordHeader';
import OrgServiceTab from './OrgServiceTab';
import OrgDocumentsTab from './OrgDocumentsTab';
import OrgSitesTab from './OrgSitesTab';
import OrgTicketsTab from './OrgTicketsTab';
import { makeOrgFetch, useLatest, type OrgRecordOrg, type OrgSummary } from './orgRecordFetch';
import { tabFromHash, visibleTabs, type OrgRecordTab } from './orgRecordTabs';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; org: OrgRecordOrg }
  | { kind: 'not-found' }
  | { kind: 'error' };

const TAB_ICONS: Record<OrgRecordTab, React.ReactNode> = {
  overview: <LayoutDashboard className="h-4 w-4" />,
  contacts: <Users className="h-4 w-4" />,
  sites: <MapPin className="h-4 w-4" />,
  devices: <Monitor className="h-4 w-4" />,
  tickets: <Ticket className="h-4 w-4" />,
  billing: <Receipt className="h-4 w-4" />,
  service: <ClipboardCheck className="h-4 w-4" />,
  documents: <FileText className="h-4 w-4" />,
  activity: <ActivityIcon className="h-4 w-4" />,
};

/**
 * The organization record (#5075 W01).
 *
 * Its org comes from the URL, never from the OrgSwitcher: every request goes
 * through `makeOrgFetch(orgId)`, so a tech reading a customer's record while
 * their workspace points at another customer sees this customer's data (and a
 * chip saying so), not a silent mix.
 *
 * Three states are load-bearing and each has its own card rather than a generic
 * error, because they mean genuinely different things to the operator:
 *   • an org-scoped sign-in cannot use this page at all (the API is
 *     partner/system scope by design — see plan critical note 2);
 *   • a `suspended`/`churned` org 404s the record GET even though the partner
 *     legitimately owns it, so the list's cached row supplies the identity;
 *   • an archived org is readable but unwritable, so its actions come off.
 */
export default function OrganizationRecordPage({ orgId }: { orgId: string }) {
  const { t } = useTranslation('organizations');
  const { t: tSettings } = useTranslation('settings');
  const claims = useJwtClaims();
  const { permissions } = usePermissions();
  const orgFetch = useMemo(() => makeOrgFetch(orgId), [orgId]);

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [summary, setSummary] = useState<OrgSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [modal, setModal] = useState<'archive' | 'merge' | null>(null);
  const orgLatest = useLatest<LoadState>();
  const summaryLatest = useLatest<OrgSummary | null>();

  // The org store is the record's fallback identity source: a suspended or
  // churned org is outside `computeAccessibleOrgIds`, so its GET 404s while the
  // list route still returns the row.
  const storeOrg = useOrgStore((s) => s.organizations.find((o) => o.id === orgId) ?? null);
  const scopeOrgId = useOrgStore((s) => s.currentOrgId);
  const scopeOrgName = useOrgStore((s) =>
    s.currentOrgId && s.currentOrgId !== orgId
      ? (s.organizations.find((o) => o.id === s.currentOrgId)?.name ?? null)
      : null,
  );
  const allOrgs = useOrgStore((s) => s.organizations);

  // The partner's stored Service Management mode (#5075 W04). Persisted and
  // seeded by the Sidebar's /orgs/partners/me fetch; it defaults to 'native' and
  // a failed fetch leaves it alone, so the record fails OPEN — hiding a module a
  // partner actually runs is worse than showing a tab they have turned off.
  const mode = useOrgStore((s) => s.serviceManagementMode);

  const isOrgScoped = claims.status === 'resolved' && claims.claims.scope === 'organization';

  const loadOrg = useCallback(async () => {
    setState({ kind: 'loading' });
    setSummaryFailed(false);
    const next = await orgLatest
      .run(
        orgFetch(`/orgs/organizations/${orgId}`).then<LoadState>(async (res) => {
          if (res.status === 404) return { kind: 'not-found' };
          if (!res.ok) return { kind: 'error' };
          return { kind: 'loaded', org: (await res.json()) as OrgRecordOrg };
        }),
      )
      .catch<LoadState>(() => ({ kind: 'error' }));
    if (next === undefined) return;
    setState(next);

    if (next.kind !== 'loaded') return;
    const nextSummary = await summaryLatest
      .run(
        orgFetch(`/orgs/organizations/${orgId}/summary`).then(async (res) =>
          res.ok ? ((await res.json()) as OrgSummary) : null,
        ),
      )
      .catch(() => null);
    if (nextSummary === undefined) return;
    setSummary(nextSummary);
    setSummaryFailed(nextSummary === null);
  }, [orgFetch, orgId, orgLatest, summaryLatest]);

  useEffect(() => {
    if (isOrgScoped) return;
    void loadOrg();
  }, [loadOrg, isOrgScoped]);

  const tabs = useMemo(() => visibleTabs(permissions, mode), [permissions, mode]);
  const [activeTab, setActiveTab] = useHashState<OrgRecordTab>('overview', tabFromHash);
  // A tab can disappear under the user (grants resolve late, W04's mode
  // arrives): fall back to Overview rather than rendering nothing.
  const effectiveTab = tabs.includes(activeTab) ? activeTab : 'overview';

  const switchTab = (id: string) => {
    const tab = tabFromHash(id);
    if (!tab) return;
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const org = state.kind === 'loaded' ? state.org : null;
  const archived = isArchiveLifecycleOrg(org);

  const handleWorkHere = () => {
    if (!org) return;
    void applyOrgSwitch(orgId, t('orgRecord.actions.workHereToast', { orgName: org.name }), '/');
  };

  const handleRestore = async () => {
    if (!org || restoring) return;
    setRestoring(true);
    try {
      await runAction({
        request: () => orgFetch(`/orgs/organizations/${orgId}/restore`, { method: 'POST' }),
        errorFallback: t('orgRecord.archived.restoreError'),
        successMessage: () => t('orgRecord.actions.restore'),
      });
      await loadOrg();
      await useOrgStore.getState().fetchOrganizations();
    } catch (err) {
      // 401 is handled by the auth redirect; any other ActionError already
      // toasted inside runAction.
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setRestoring(false);
    }
  };

  if (isOrgScoped) {
    return (
      <Centered
        testId="org-record-unavailable"
        icon={<Building2 className="h-7 w-7" aria-hidden="true" />}
        title={t('orgRecord.unavailable.title')}
        description={t('orgRecord.unavailable.description')}
        actionLabel={t('orgRecord.unavailable.action')}
        actionHref="/"
      />
    );
  }

  if (state.kind === 'loading') {
    return (
      <div data-testid="org-record-loading" className="space-y-4" aria-busy="true">
        <span className="sr-only">{t('orgRecord.loading')}</span>
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <Centered
        testId="org-record-error"
        icon={<AlertCircle className="h-7 w-7" aria-hidden="true" />}
        title={t('orgRecord.error.title')}
        description={t('orgRecord.error.description')}
        actionLabel={t('orgRecord.actions.retry')}
        onAction={() => void loadOrg()}
      />
    );
  }

  if (state.kind === 'not-found') {
    // A partner token cannot reach a suspended/churned org through the record
    // GET, but it is still their customer — name it from the list's cached row
    // rather than claiming the org does not exist.
    const lifecycleOrg =
      storeOrg && (storeOrg.status === 'suspended' || storeOrg.status === 'churned') ? storeOrg : null;
    if (lifecycleOrg) {
      const statusLabelKey = statusLabelKeys[lifecycleOrg.status];
      return (
        <Centered
          testId="org-record-lifecycle"
          icon={<Building2 className="h-7 w-7" aria-hidden="true" />}
          title={lifecycleOrg.name}
          description={t('orgRecord.lifecycle.inaccessible', {
            status: statusLabelKey ? tSettings(/* i18n-dynamic */ statusLabelKey) : lifecycleOrg.status,
          })}
          detail={lifecycleOrg.createdAt ? t('orgRecord.header.created', { date: formatDate(lifecycleOrg.createdAt) }) : undefined}
          actionLabel={t('orgRecord.lifecycle.backToList')}
          actionHref="/settings/organizations"
        />
      );
    }
    return (
      <Centered
        testId="org-record-not-found"
        icon={<Building2 className="h-7 w-7" aria-hidden="true" />}
        title={t('orgRecord.notFound.title')}
        description={t('orgRecord.notFound.description')}
        actionLabel={t('orgRecord.notFound.action')}
        actionHref="/settings/organizations"
      />
    );
  }

  const loadedOrg = state.org;
  const canMerge = claims.status === 'resolved' && claims.claims.scope === 'partner';
  const modalOrg = { ...loadedOrg, status: loadedOrg.status as Organization['status'] } as Organization;

  const overflowTabs: OverflowTab[] = tabs.map((tab) => ({
    id: tab,
    label: t(/* i18n-dynamic */ `orgRecord.tabs.${tab}`),
    icon: TAB_ICONS[tab],
  }));

  return (
    <div className="space-y-5">
      <OrgRecordHeader
        org={loadedOrg}
        summary={summary}
        archived={archived}
        mismatchedScopeOrgName={scopeOrgId && scopeOrgId !== orgId ? scopeOrgName : null}
        onWorkHere={handleWorkHere}
        onOpenSettings={() => void navigateTo(`/settings/organizations/${orgId}`)}
        onArchive={archived ? undefined : () => setModal('archive')}
        onMerge={archived || !canMerge ? undefined : () => setModal('merge')}
      />

      {archived && (
        <div
          data-testid="org-record-archived-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm"
        >
          <span>{t('orgRecord.archived.banner')}</span>
          <button
            type="button"
            data-testid="org-record-restore"
            disabled={restoring}
            onClick={() => void handleRestore()}
            className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-60"
          >
            {t('orgRecord.actions.restore')}
          </button>
        </div>
      )}

      <OverflowTabs tabs={overflowTabs} activeTab={effectiveTab} onTabChange={switchTab} />

      {effectiveTab === 'overview' && (
        <OrgOverviewTab orgId={orgId} orgFetch={orgFetch} summary={summary} summaryFailed={summaryFailed} mode={mode} />
      )}
      {effectiveTab === 'contacts' && <ContactsCard orgId={orgId} />}
      {effectiveTab === 'sites' && <OrgSitesTab orgId={orgId} orgName={loadedOrg.name} />}
      {effectiveTab === 'devices' && <OrgDevicesTab orgId={orgId} orgFetch={orgFetch} />}
      {effectiveTab === 'activity' && <OrgActivityTab orgId={orgId} />}
      {effectiveTab === 'tickets' && <OrgTicketsTab orgId={orgId} orgFetch={orgFetch} />}
      {effectiveTab === 'billing' && <OrgBillingTab orgId={orgId} />}
      {effectiveTab === 'service' && <OrgServiceTab orgId={orgId} orgFetch={orgFetch} />}
      {effectiveTab === 'documents' && <OrgDocumentsTab orgId={orgId} orgFetch={orgFetch} />}

      {modal === 'archive' && (
        <ArchiveOrgModal
          org={modalOrg}
          onClose={() => setModal(null)}
          onArchived={() => void loadOrg()}
          onDoneClose={() => setModal(null)}
        />
      )}
      {modal === 'merge' && (
        <MergeOrgModal
          loserOrg={modalOrg}
          orgs={allOrgs}
          onClose={() => setModal(null)}
          onMerged={() => undefined}
          onDoneClose={() => {
            setModal(null);
            void navigateTo('/settings/organizations');
          }}
        />
      )}
    </div>
  );
}

function Centered({
  testId,
  icon,
  title,
  description,
  detail,
  actionLabel,
  actionHref,
  onAction,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  detail?: string;
  actionLabel: string;
  actionHref?: string;
  onAction?: () => void;
}) {
  return (
    <div data-testid={testId} className="mx-auto max-w-md rounded-lg border border-dashed px-5 py-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <h1 className="mt-3 text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      {actionHref ? (
        <a
          className="mt-4 inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          href={actionHref}
        >
          {actionLabel}
        </a>
      ) : (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
