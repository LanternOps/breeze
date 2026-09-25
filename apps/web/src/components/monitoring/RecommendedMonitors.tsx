import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import '../../lib/i18n';

/**
 * Library "Recommended" strip (#6371, W05c2 Task 13): shipped built-in
 * monitors that are not attached to any policy the caller can see, with a
 * picker that attaches all of them to one policy in a single feature-link
 * save. Independent of W05a's strip on the policy Monitors tab.
 *
 * The write goes through the policy's `monitors` feature link (not the
 * per-monitor attach route) so the link's existing items and its
 * `inheritance` mode — including `replace` — survive the save. The server
 * enforces ownership, attachability, partner-wide and site authorization.
 */
type Recommendation = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  builtinKey?: string | null;
  attachmentCount?: number;
};

type Policy = { id: string; name: string };

type MonitorsLink = {
  id: string;
  featureType: string;
  featurePolicyId?: string | null;
  inlineSettings?: { items?: Array<Record<string, unknown> & { monitorId: string }>; inheritance?: string } | null;
};

const PAGE_SIZE = 100;

export default function RecommendedMonitors({
  rows,
  onAttached,
}: {
  rows: Recommendation[];
  onAttached: () => void;
}) {
  const { t } = useTranslation(['monitoring', 'common']);
  // Only partner-owned built-ins with a KNOWN zero count: an absent count is
  // "unknown", never "not deployed".
  const candidates = rows.filter(
    (row) => row.builtinKey && row.partnerId && !row.orgId && row.attachmentCount === 0,
  );
  const [open, setOpen] = useState(false);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadPolicies = async () => {
    setOpen(true);
    setLoading(true);
    setError(false);
    setPolicies([]);
    setPolicyId('');
    try {
      const all: Policy[] = [];
      for (let page = 1; ; page++) {
        const response = await fetchWithAuth(
          `/configuration-policies?status=active&limit=${PAGE_SIZE}&page=${page}`,
        );
        if (!response.ok) throw new Error('policy_read_failed');
        const body = (await response.json()) as { data?: Policy[]; pagination?: { total?: number } };
        if (!Array.isArray(body.data)) throw new Error('policy_read_failed');
        all.push(...body.data);
        if (body.data.length < PAGE_SIZE || all.length >= (body.pagination?.total ?? all.length)) break;
      }
      setPolicies(all);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const attach = async () => {
    if (!policyId || busy || candidates.length === 0) return;
    setBusy(true);
    try {
      const response = await fetchWithAuth(`/configuration-policies/${policyId}/features`);
      if (!response.ok) throw new Error('feature_read_failed');
      const body = (await response.json()) as { data?: MonitorsLink[] };
      const link = (body.data ?? []).find((value) => value.featureType === 'monitors');
      // A link pointing at a shared feature policy is not edited from here —
      // tell the user why, since retrying the same policy can never succeed.
      if (link?.featurePolicyId) {
        showToast({ type: 'error', message: t('monitoring:deploy.errors.linkedFeature') });
        return;
      }
      const settings = link?.inlineSettings ?? {};
      const items = [...(settings.items ?? [])];
      for (const row of candidates) {
        if (!items.some((item) => item.monitorId === row.id)) {
          items.push({ monitorId: row.id, enabled: true, sortOrder: items.length });
        }
      }
      const inlineSettings = { ...settings, inheritance: settings.inheritance ?? 'cumulative', items };
      await runAction({
        request: () =>
          fetchWithAuth(`/configuration-policies/${policyId}/features${link ? `/${link.id}` : ''}`, {
            method: link ? 'PATCH' : 'POST',
            body: JSON.stringify({ featureType: 'monitors', featurePolicyId: null, inlineSettings }),
          }),
        errorFallback: t('monitoring:deploy.errors.attach'),
        successMessage: t('monitoring:deploy.attached'),
      });
      setOpen(false);
      onAttached();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:deploy.errors.attach') });
    } finally {
      setBusy(false);
    }
  };

  if (candidates.length === 0) return null;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm" data-testid="library-recommended">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            {t('monitoring:list.recommended.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('monitoring:list.recommended.description')}</p>
        </div>
        <button
          type="button"
          data-testid="recommended-open"
          onClick={() => void loadPolicies()}
          disabled={loading || busy}
          className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {t('monitoring:deploy.attachToPolicy')}
        </button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-2">
          {loading && <p className="text-sm text-muted-foreground">{t('common:states.loading')}</p>}
          {error && (
            <button
              type="button"
              data-testid="recommended-retry"
              onClick={() => void loadPolicies()}
              className="h-9 rounded-md border px-3 text-sm hover:bg-muted"
            >
              {t('common:actions.retry')}
            </button>
          )}
          <select
            aria-label={t('monitoring:deploy.selectPolicy')}
            data-testid="recommended-policy"
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
            className="h-9 min-w-[16rem] rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="">{t('monitoring:deploy.selectPolicy')}</option>
            {policies.map((policy) => (
              <option value={policy.id} key={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="recommended-attach"
            disabled={!policyId || loading || error || busy}
            onClick={() => void attach()}
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('monitoring:deploy.attach')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setOpen(false)}
            className="h-9 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
        </div>
      )}
    </section>
  );
}
