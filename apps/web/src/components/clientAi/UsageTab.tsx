import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — usage & billing report (spec §8, §9.4). The CSV is the MSP's
 * resale-invoicing artifact (Plan-4 Task 4 pins its column order server-side).
 * GET-only component: list + CSV export, no mutations — deliberately NOT in
 * the no-silent-mutations TARGET_GLOBS.
 */

/** Row/totals shapes of GET /client-ai/admin/usage (Plan-4 Task 4). */
interface UsageRow {
  month: string;
  orgId: string;
  orgName: string | null;
  clientUserId: string | null;
  userEmail: string | null;
  messageCount: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface UsageTotals {
  messageCount: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

interface OrgGroup {
  orgId: string;
  orgName: string | null;
  rows: UsageRow[];
  subtotal: UsageTotals;
}

export default function UsageTab() {
  const [from, setFrom] = useState(currentMonthKey());
  const [to, setTo] = useState(currentMonthKey());
  const [orgFilter, setOrgFilter] = useState('');
  const [orgs, setOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());

  const rangeValid = from !== '' && to !== '' && from <= to;

  useEffect(() => {
    void fetchWithAuth('/client-ai/admin/orgs')
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { orgId: string; orgName: string }[] }>) : null))
      .then((b) => {
        if (b?.data) setOrgs(b.data.map(({ orgId, orgName }) => ({ orgId, orgName })));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!rangeValid) return;
    try {
      setLoading(true);
      setLoadError(false);
      const qs = new URLSearchParams({ from, to });
      if (orgFilter) qs.set('orgId', orgFilter);
      const res = await fetchWithAuth(`/client-ai/admin/usage?${qs.toString()}`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { rows: UsageRow[]; totals: UsageTotals };
      setRows(body.rows ?? []);
      setTotals(body.totals ?? null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [from, to, orgFilter, rangeValid]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo<OrgGroup[]>(() => {
    const byOrg = new Map<string, OrgGroup>();
    for (const r of rows) {
      let g = byOrg.get(r.orgId);
      if (!g) {
        g = {
          orgId: r.orgId,
          orgName: r.orgName,
          rows: [],
          subtotal: { messageCount: 0, sessionCount: 0, inputTokens: 0, outputTokens: 0, costCents: 0 },
        };
        byOrg.set(r.orgId, g);
      }
      g.rows.push(r);
      g.subtotal.messageCount += r.messageCount;
      g.subtotal.sessionCount += r.sessionCount;
      g.subtotal.inputTokens += r.inputTokens;
      g.subtotal.outputTokens += r.outputTokens;
      g.subtotal.costCents = Math.round((g.subtotal.costCents + r.costCents) * 100) / 100;
    }
    return [...byOrg.values()];
  }, [rows]);

  const toggleOrg = (orgId: string) =>
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) {
        next.delete(orgId);
      } else {
        next.add(orgId);
      }
      return next;
    });

  // CSV export — the BillablesExportCard.tsx blob-download pattern. The
  // filename matches the route's Content-Disposition (Plan-4 Task 4).
  const downloadCsv = async () => {
    if (downloading || !rangeValid) return;
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (orgFilter) qs.set('orgId', orgFilter);
      const res = await fetchWithAuth(`/client-ai/admin/usage.csv?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast({
          type: 'error',
          message: (body as { error?: string } | null)?.error ?? 'Export failed',
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `client-ai-usage-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', message: 'Export failed' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Range + filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          From month
          <input
            type="month"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-usage-from"
          />
        </label>
        <label className="text-xs">
          To month
          <input
            type="month"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-usage-to"
          />
        </label>
        <label className="text-xs">
          Organization
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-usage-org"
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void downloadCsv()}
          disabled={downloading || !rangeValid}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          data-testid="ai-office-usage-export"
        >
          <Download className="h-4 w-4" />
          {downloading ? 'Exporting…' : 'Export CSV'}
        </button>
        {!rangeValid && (
          <span className="pb-1.5 text-xs text-destructive">From month must be ≤ to month</span>
        )}
      </div>

      {/* Report table */}
      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="ai-office-usage-load-error">
            Failed to load the usage report.{' '}
            <button type="button" className="text-primary underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">Organization / user</th>
                  <th className="px-4 py-2">Month</th>
                  <th className="px-4 py-2 text-right">Messages</th>
                  <th className="px-4 py-2 text-right">Sessions</th>
                  <th className="px-4 py-2 text-right">Tokens (in/out)</th>
                  <th className="px-4 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const expanded = expandedOrgs.has(g.orgId);
                  return (
                    <Fragment key={g.orgId}>
                      <tr
                        onClick={() => toggleOrg(g.orgId)}
                        className="cursor-pointer border-b font-medium hover:bg-muted/20"
                        data-testid={`ai-office-usage-org-${g.orgId}`}
                      >
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5">
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            {g.orgName ?? g.orgId}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {g.rows.length} row{g.rows.length === 1 ? '' : 's'}
                        </td>
                        <td className="px-4 py-2.5 text-right">{g.subtotal.messageCount}</td>
                        <td className="px-4 py-2.5 text-right">{g.subtotal.sessionCount}</td>
                        <td className="px-4 py-2.5 text-right">
                          {formatTokens(g.subtotal.inputTokens)} / {formatTokens(g.subtotal.outputTokens)}
                        </td>
                        <td className="px-4 py-2.5 text-right">{formatCost(g.subtotal.costCents)}</td>
                      </tr>
                      {expanded &&
                        g.rows.map((r) => (
                          <tr
                            key={`${r.orgId}-${r.clientUserId}-${r.month}`}
                            className="border-b bg-muted/10 last:border-0"
                            data-testid="ai-office-usage-user-row"
                          >
                            <td className="px-4 py-2 pl-12 text-muted-foreground">
                              {r.userEmail ?? r.clientUserId ?? '—'}
                            </td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">{r.month}</td>
                            <td className="px-4 py-2 text-right">{r.messageCount}</td>
                            <td className="px-4 py-2 text-right">{r.sessionCount}</td>
                            <td className="px-4 py-2 text-right">
                              {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
                            </td>
                            <td className="px-4 py-2 text-right">{formatCost(r.costCents)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No usage recorded in this range
                    </td>
                  </tr>
                )}
              </tbody>
              {totals && groups.length > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/30 font-semibold" data-testid="ai-office-usage-totals">
                    <td className="px-4 py-2.5" colSpan={2}>
                      Total
                    </td>
                    <td className="px-4 py-2.5 text-right">{totals.messageCount}</td>
                    <td className="px-4 py-2.5 text-right">{totals.sessionCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      {formatTokens(totals.inputTokens)} / {formatTokens(totals.outputTokens)}
                    </td>
                    <td className="px-4 py-2.5 text-right">{formatCost(totals.costCents)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
