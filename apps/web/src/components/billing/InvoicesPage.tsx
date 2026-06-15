import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { Dialog } from '../shared/Dialog';
import {
  type InvoiceStatus,
  type InvoiceSummary,
  STATUS_COLORS,
  STATUS_LABELS,
  formatDate,
  formatMoney,
} from './invoiceTypes';

interface Organization {
  id: string;
  name: string;
}
interface Site {
  id: string;
  name: string;
}

const STATUS_OPTIONS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

// ---- hash filter state (key=value&key=value) ----------------------------
interface Filters {
  orgId: string;
  status: '' | InvoiceStatus;
  from: string;
  to: string;
}
const EMPTY_FILTERS: Filters = { orgId: '', status: '', from: '', to: '' };

function readFilters(): Filters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const status = params.get('status') ?? '';
  return {
    orgId: params.get('orgId') ?? '',
    status: (STATUS_OPTIONS.some((o) => o.value === status) ? status : '') as Filters['status'],
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
}

function writeFilters(f: Filters): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (f.orgId) params.set('orgId', f.orgId);
  if (f.status) params.set('status', f.status);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  const next = params.toString();
  window.location.hash = next ? `#${next}` : '';
}

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filters, setFilters] = useState<Filters>(() => readFilters());

  // Assemble dialog state
  const [assembleOpen, setAssembleOpen] = useState(false);
  const [assembleOrgId, setAssembleOrgId] = useState('');
  const [assembleSiteId, setAssembleSiteId] = useState('');
  const [assembleFrom, setAssembleFrom] = useState('');
  const [assembleTo, setAssembleTo] = useState('');
  const [assembleSites, setAssembleSites] = useState<Site[]>([]);
  const [assembling, setAssembling] = useState(false);

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [orgs],
  );

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations');
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load organizations.'); return; }
    const body = (await res.json()) as { data?: Organization[]; organizations?: Organization[] };
    setOrgs(body.data ?? body.organizations ?? []);
  }, []);

  const loadInvoices = useCallback(async (f: Filters) => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (f.orgId) params.set('orgId', f.orgId);
      if (f.status) params.set('status', f.status);
      if (f.from) params.set('from', f.from);
      if (f.to) params.set('to', f.to);
      const qs = params.toString();
      const res = await fetchWithAuth(`/invoices${qs ? `?${qs}` : ''}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('Failed to load invoices');
      const body = (await res.json()) as { data: InvoiceSummary[] };
      setInvoices(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadInvoices(filters); }, [loadInvoices, filters]);

  // React to back/forward hash changes.
  useEffect(() => {
    const onHash = () => setFilters(readFilters());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      writeFilters(next);
      return next;
    });
  }, []);

  // Load sites for the assemble org picker.
  const loadAssembleSites = useCallback(async (orgId: string) => {
    setAssembleSiteId('');
    setAssembleSites([]);
    if (!orgId) return;
    const res = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load sites.'); return; }
    const body = (await res.json()) as { data?: Site[]; sites?: Site[] };
    setAssembleSites(body.data ?? body.sites ?? []);
  }, []);

  const openAssemble = useCallback(() => {
    setAssembleOrgId(filters.orgId || '');
    setAssembleSiteId('');
    setAssembleSites([]);
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86400000);
    setAssembleFrom(monthAgo.toISOString().slice(0, 10));
    setAssembleTo(today.toISOString().slice(0, 10));
    setAssembleOpen(true);
    if (filters.orgId) void loadAssembleSites(filters.orgId);
  }, [filters.orgId, loadAssembleSites]);

  const submitAssemble = useCallback(async () => {
    if (assembling) return;
    if (!assembleOrgId || !assembleFrom || !assembleTo) return;
    setAssembling(true);
    try {
      const result = await runAction<{ data: { invoice: { id: string } } }>({
        request: () =>
          fetchWithAuth(`/orgs/${assembleOrgId}/invoices/assemble`, {
            method: 'POST',
            body: JSON.stringify({
              siteId: assembleSiteId || undefined,
              from: assembleFrom,
              to: assembleTo,
            }),
          }),
        errorFallback: 'Could not assemble an invoice for that range.',
        successMessage: 'Draft invoice assembled',
        onUnauthorized: UNAUTHORIZED,
      });
      setAssembleOpen(false);
      const newId = result?.data?.invoice?.id;
      if (newId) void navigateTo(`/billing/invoices/${newId}`);
      else void loadInvoices(filters);
    } catch (err) {
      handleActionError(err, 'Could not assemble an invoice for that range.');
    } finally {
      setAssembling(false);
    }
  }, [assembling, assembleOrgId, assembleSiteId, assembleFrom, assembleTo, filters, loadInvoices]);

  const isOverdue = (inv: InvoiceSummary) => inv.status === 'overdue';

  const rows = useMemo(() => invoices, [invoices]);

  return (
    <div className="space-y-6" data-testid="invoices-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Invoices</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Assemble, issue, and track customer invoices.
          </p>
        </div>
        <button
          type="button"
          onClick={openAssemble}
          data-testid="invoices-assemble-open"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Assemble invoice
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3" data-testid="invoices-filters">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Organization
          <select
            value={filters.orgId}
            onChange={(e) => applyFilter({ orgId: e.target.value })}
            data-testid="invoices-filter-org"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Status
          <select
            value={filters.status}
            onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
            data-testid="invoices-filter-status"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={filters.from}
            onChange={(e) => applyFilter({ from: e.target.value })}
            data-testid="invoices-filter-from"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={filters.to}
            onChange={(e) => applyFilter({ to: e.target.value })}
            data-testid="invoices-filter-to"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12" data-testid="invoices-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-destructive" data-testid="invoices-error">
            {error}
            <div>
              <button
                type="button"
                onClick={() => void loadInvoices(filters)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Try again
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="invoices-empty">
            No invoices match these filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="invoices-table">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-3 font-medium">Number</th>
                  <th className="px-3 py-3 font-medium">Organization</th>
                  <th className="px-3 py-3 font-medium">Issued</th>
                  <th className="px-3 py-3 font-medium">Due</th>
                  <th className="px-3 py-3 text-right font-medium">Total</th>
                  <th className="px-3 py-3 text-right font-medium">Balance</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((inv) => (
                  <tr
                    key={inv.id}
                    onClick={() => void navigateTo(`/billing/invoices/${inv.id}`)}
                    data-testid={`invoices-row-${inv.id}`}
                    className={`cursor-pointer border-t transition hover:bg-muted/40 ${
                      isOverdue(inv) ? 'bg-red-500/5' : ''
                    }`}
                  >
                    <td className="px-3 py-3 font-medium">
                      {inv.invoiceNumber ?? <span className="text-muted-foreground">Draft</span>}
                    </td>
                    <td className="px-3 py-3">{orgName(inv.orgId)}</td>
                    <td className="px-3 py-3">{formatDate(inv.issueDate)}</td>
                    <td className="px-3 py-3">{formatDate(inv.dueDate)}</td>
                    <td className="px-3 py-3 text-right">{formatMoney(inv.total, inv.currencyCode)}</td>
                    <td className="px-3 py-3 text-right">{formatMoney(inv.balance, inv.currencyCode)}</td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[inv.status]}`}
                        data-testid={`invoices-status-${inv.id}`}
                      >
                        {STATUS_LABELS[inv.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Assemble dialog */}
      <Dialog
        open={assembleOpen}
        onClose={() => setAssembleOpen(false)}
        title="Assemble invoice"
        maxWidth="lg"
        className="p-6"
      >
        <div className="space-y-4" data-testid="invoices-assemble-dialog">
          <div>
            <h2 className="text-lg font-semibold">Assemble invoice</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pull unbilled time entries and parts for an organization into a new draft.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Organization
            <select
              value={assembleOrgId}
              onChange={(e) => { setAssembleOrgId(e.target.value); void loadAssembleSites(e.target.value); }}
              data-testid="invoices-assemble-org"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select an organization…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Site (optional)
            <select
              value={assembleSiteId}
              onChange={(e) => setAssembleSiteId(e.target.value)}
              data-testid="invoices-assemble-site"
              disabled={!assembleOrgId || assembleSites.length === 0}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              <option value="">All sites</option>
              {assembleSites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              From
              <input
                type="date"
                value={assembleFrom}
                onChange={(e) => setAssembleFrom(e.target.value)}
                data-testid="invoices-assemble-from"
                className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              To
              <input
                type="date"
                value={assembleTo}
                onChange={(e) => setAssembleTo(e.target.value)}
                data-testid="invoices-assemble-to"
                className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setAssembleOpen(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitAssemble()}
              disabled={!assembleOrgId || !assembleFrom || !assembleTo || assembling}
              data-testid="invoices-assemble-submit"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {assembling ? 'Assembling…' : 'Assemble'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// re-exported for tests that need the error type
export { ActionError };
