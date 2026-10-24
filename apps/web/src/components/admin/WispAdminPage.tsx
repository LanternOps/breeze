import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, RefreshCw, Lock, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
// Initializes the shared i18next singleton — see ThirdPartyCatalog.tsx for why
// this import must run before any island renders translated text.
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';
import { formatDateTime } from '@/lib/dateTimeFormat';

// Contract of the platform-admin Wisp routes (apps/api/src/routes/admin/wisp.ts).
interface WispPartnerOverviewRow {
  partnerId: string;
  partnerName: string;
  plan: string;
  activeGrants: number;
  pausedGrants: Record<string, number>;
  assessmentsToday: number;
  specialistRequestsToday: number;
  openConcerns: number;
  budgetExhaustedGrantsToday: number;
}

interface WispGrantAdminRow {
  id: string;
  orgId: string | null;
  grantorUserId: string;
  grantorName: string | null;
  status: 'active' | 'paused' | 'revoked' | 'expired';
  pausedReason: string | null;
  expiresAt: string;
  budgetCentsPerDay: number;
  floorTickMinutes: number;
  currentRevisionId: string;
  assessmentsToday: number;
}

type PageState = 'loading' | 'ready' | 'locked' | 'disabled' | 'error';

interface GrantsState {
  loading: boolean;
  error: boolean;
  grants: WispGrantAdminRow[];
}

const COLUMN_COUNT = 9;

function sumPaused(paused: Record<string, number>): number {
  return Object.values(paused).reduce((a, b) => a + b, 0);
}

export default function WispAdminPage() {
  const { t } = useTranslation('admin');
  const stableT = useStableT(t); // effect-safe translator; JSX keeps `t`
  const [state, setState] = useState<PageState>('loading');
  const [partners, setPartners] = useState<WispPartnerOverviewRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [grantsByPartner, setGrantsByPartner] = useState<Record<string, GrantsState>>({});
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    setErrorMessage('');
    try {
      const response = await fetchWithAuth('/admin/wisp/overview');
      if (response.status === 403) {
        setState('locked');
        return;
      }
      if (response.status === 404) {
        setState('disabled');
        return;
      }
      if (!response.ok) throw new Error(stableT('admin.wisp.errors.load'));
      const body = (await response.json()) as { partners?: WispPartnerOverviewRow[] };
      setPartners(body.partners ?? []);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : stableT('admin.wisp.errors.generic'));
      setState('error');
    }
  }, [stableT]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadGrants = useCallback(async (partnerId: string) => {
    setGrantsByPartner((prev) => ({ ...prev, [partnerId]: { loading: true, error: false, grants: [] } }));
    try {
      const response = await fetchWithAuth(`/admin/wisp/grants?partnerId=${encodeURIComponent(partnerId)}`);
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { grants?: WispGrantAdminRow[] };
      setGrantsByPartner((prev) => ({
        ...prev,
        [partnerId]: { loading: false, error: false, grants: body.grants ?? [] },
      }));
    } catch {
      setGrantsByPartner((prev) => ({ ...prev, [partnerId]: { loading: false, error: true, grants: [] } }));
    }
  }, []);

  const togglePartner = (partnerId: string) => {
    if (expanded === partnerId) {
      setExpanded(null);
      return;
    }
    setExpanded(partnerId);
    const existing = grantsByPartner[partnerId];
    if (!existing || existing.error) void loadGrants(partnerId);
  };

  const pausedReasonLabel = (reason: string): string => {
    switch (reason) {
      case 'budget_exhausted':
        return t('admin.wisp.pausedReason.budget_exhausted');
      case 'grantor_suspended':
        return t('admin.wisp.pausedReason.grantor_suspended');
      case 'grantor_access_lost':
        return t('admin.wisp.pausedReason.grantor_access_lost');
      case 'factor_expired':
        return t('admin.wisp.pausedReason.factor_expired');
      case 'entitlement_lost':
        return t('admin.wisp.pausedReason.entitlement_lost');
      case 'user_paused':
        return t('admin.wisp.pausedReason.user_paused');
      case 'partner_disabled':
        return t('admin.wisp.pausedReason.partner_disabled');
      default:
        return reason;
    }
  };

  const statusLabel = (status: WispGrantAdminRow['status']): string => {
    switch (status) {
      case 'active':
        return t('admin.wisp.status.active');
      case 'paused':
        return t('admin.wisp.status.paused');
      case 'revoked':
        return t('admin.wisp.status.revoked');
      case 'expired':
        return t('admin.wisp.status.expired');
      default:
        return status;
    }
  };

  const header = (
    <h1 className="text-2xl font-semibold flex items-center gap-2 mb-6">
      <Sparkles className="w-6 h-6" /> {t('admin.wisp.title')}
    </h1>
  );

  if (state === 'locked') {
    return (
      <div className="p-6">
        {header}
        <div
          data-testid="wisp-admin-locked"
          className="bg-blue-50 border border-blue-200 text-blue-900 px-6 py-8 rounded flex items-start gap-4"
        >
          <Lock className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">{t('admin.wisp.platformAdmin.title')}</div>
            <div className="text-sm">{t('admin.wisp.platformAdmin.description')}</div>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'disabled') {
    return (
      <div className="p-6">
        {header}
        <div
          data-testid="wisp-admin-disabled"
          className="bg-amber-50 border border-amber-200 text-amber-900 px-6 py-6 rounded text-sm"
        >
          {t('admin.wisp.disabled')}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="w-6 h-6" /> {t('admin.wisp.title')}
          </h1>
          <p className="text-sm text-gray-600 mt-1 max-w-2xl">{t('admin.wisp.description')}</p>
        </div>
        <button
          data-testid="wisp-admin-refresh"
          onClick={() => void load()}
          className="px-3 py-2 text-sm border rounded hover:bg-gray-50 flex items-center gap-1"
        >
          <RefreshCw className="w-4 h-4" /> {t('admin.wisp.refresh')}
        </button>
      </div>

      {state === 'error' && (
        <div
          data-testid="wisp-admin-error"
          className="bg-red-50 text-red-800 px-4 py-3 rounded mb-4 flex items-center justify-between"
        >
          <span>{errorMessage}</span>
          <button
            data-testid="wisp-admin-retry"
            onClick={() => void load()}
            className="px-3 py-1 text-sm border border-red-300 rounded hover:bg-red-100"
          >
            {t('admin.wisp.retry')}
          </button>
        </div>
      )}

      {state === 'loading' && (
        <div data-testid="wisp-admin-loading" className="text-center py-12 text-gray-500">
          {t('admin.wisp.loading')}
        </div>
      )}

      {state === 'ready' && partners.length === 0 && (
        <div data-testid="wisp-admin-empty" className="text-center py-12 text-gray-500">
          {t('admin.wisp.empty')}
        </div>
      )}

      {state === 'ready' && partners.length > 0 && (
        <div className="overflow-x-auto rounded border bg-card">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 w-8" />
                <th className="px-4 py-3">{t('admin.wisp.table.partner')}</th>
                <th className="px-4 py-3">{t('admin.wisp.table.plan')}</th>
                <th className="px-4 py-3 text-right">{t('admin.wisp.table.activeGrants')}</th>
                <th className="px-4 py-3 text-right">{t('admin.wisp.table.pausedGrants')}</th>
                <th className="px-4 py-3 text-right">{t('admin.wisp.table.assessmentsToday')}</th>
                <th className="px-4 py-3 text-right">{t('admin.wisp.table.specialistRequestsToday')}</th>
                <th className="px-4 py-3 text-right">{t('admin.wisp.table.openConcerns')}</th>
                <th className="px-4 py-3 text-right">{t('admin.wisp.table.budgetExhaustedToday')}</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => {
                const isOpen = expanded === p.partnerId;
                const g = grantsByPartner[p.partnerId];
                const breakdown = Object.entries(p.pausedGrants)
                  .map(([reason, n]) => `${pausedReasonLabel(reason)}: ${n}`)
                  .join(', ');
                return (
                  <Fragment key={p.partnerId}>
                    <tr
                      data-testid={`wisp-admin-partner-row-${p.partnerId}`}
                      onClick={() => togglePartner(p.partnerId)}
                      className="border-t cursor-pointer hover:bg-muted/30"
                    >
                      <td className="px-4 py-3">
                        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {/* The row is clickable for pointer users; this button is the
                            keyboard/screen-reader control for the same toggle. */}
                        <button
                          type="button"
                          data-testid={`wisp-admin-partner-toggle-${p.partnerId}`}
                          aria-expanded={isOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePartner(p.partnerId);
                          }}
                          className="text-left font-medium hover:underline"
                        >
                          {p.partnerName}
                        </button>
                      </td>
                      <td className="px-4 py-3">{p.plan}</td>
                      <td className="px-4 py-3 text-right">{p.activeGrants}</td>
                      <td className="px-4 py-3 text-right" title={breakdown || undefined}>
                        {sumPaused(p.pausedGrants)}
                        {breakdown && <div className="text-xs text-gray-500">{breakdown}</div>}
                      </td>
                      <td className="px-4 py-3 text-right">{p.assessmentsToday}</td>
                      <td className="px-4 py-3 text-right">{p.specialistRequestsToday}</td>
                      <td className="px-4 py-3 text-right">{p.openConcerns}</td>
                      <td className="px-4 py-3 text-right">{p.budgetExhaustedGrantsToday}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={COLUMN_COUNT} className="bg-muted/20 px-4 py-3">
                          <div data-testid={`wisp-admin-grants-${p.partnerId}`}>
                            {(!g || g.loading) && (
                              <div className="text-sm text-gray-500">{t('admin.wisp.grants.loading')}</div>
                            )}
                            {g?.error && (
                              <div className="text-sm text-red-700 flex items-center gap-3">
                                {t('admin.wisp.grants.error')}
                                <button
                                  data-testid={`wisp-admin-grants-retry-${p.partnerId}`}
                                  onClick={() => void loadGrants(p.partnerId)}
                                  className="px-2 py-1 border rounded hover:bg-muted"
                                >
                                  {t('admin.wisp.retry')}
                                </button>
                              </div>
                            )}
                            {g && !g.loading && !g.error && g.grants.length === 0 && (
                              <div className="text-sm text-gray-500">{t('admin.wisp.grants.empty')}</div>
                            )}
                            {g && !g.loading && !g.error && g.grants.length > 0 && (
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                                    <th className="py-2 pr-4">{t('admin.wisp.grants.grantor')}</th>
                                    <th className="py-2 pr-4">{t('admin.wisp.grants.scope')}</th>
                                    <th className="py-2 pr-4">{t('admin.wisp.grants.status')}</th>
                                    <th className="py-2 pr-4">{t('admin.wisp.grants.pausedReason')}</th>
                                    <th className="py-2 pr-4">{t('admin.wisp.grants.expires')}</th>
                                    <th className="py-2 pr-4 text-right">{t('admin.wisp.grants.budget')}</th>
                                    <th className="py-2 pr-4 text-right">{t('admin.wisp.grants.tickMinutes')}</th>
                                    <th className="py-2 text-right">{t('admin.wisp.grants.assessmentsToday')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {g.grants.map((grant) => (
                                    <tr key={grant.id} data-testid={`wisp-admin-grant-${grant.id}`} className="border-t">
                                      <td className="py-2 pr-4" title={grant.grantorUserId}>
                                        {grant.grantorName?.trim() || grant.grantorUserId.slice(0, 8)}
                                      </td>
                                      <td className="py-2 pr-4 font-mono text-xs">
                                        {grant.orgId ?? t('admin.wisp.grants.partnerWide')}
                                      </td>
                                      <td className="py-2 pr-4">{statusLabel(grant.status)}</td>
                                      <td className="py-2 pr-4">
                                        {grant.pausedReason ? pausedReasonLabel(grant.pausedReason) : '—'}
                                      </td>
                                      <td className="py-2 pr-4">{formatDateTime(grant.expiresAt)}</td>
                                      <td className="py-2 pr-4 text-right">{grant.budgetCentsPerDay}</td>
                                      <td className="py-2 pr-4 text-right">{grant.floorTickMinutes}</td>
                                      <td className="py-2 text-right">{grant.assessmentsToday}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
