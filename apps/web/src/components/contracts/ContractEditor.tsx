import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import {
  createContract,
  updateContract,
  addContractLine,
  removeContractLine,
  contractTransition,
  getContractEstimate,
  type ContractBillingTiming,
  type ContractDetail,
  type ContractLine,
  type ContractLineType,
  type ContractEstimate,
} from '../../lib/api/contracts';
import CatalogItemPicker from '../catalog/CatalogItemPicker';
import { listCatalog, type CatalogItem } from '../../lib/api/catalog';
import { formatMoney } from '../billing/invoiceTypes';
import { usePermissions } from '../../lib/permissions';

interface Organization { id: string; name: string }
interface Site { id: string; name: string }

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

const LINE_TYPE_LABELS: Record<ContractLineType, string> = {
  flat: 'Flat fee',
  per_device: 'Per device',
  per_seat: 'Per seat',
  manual: 'Manual quantity',
};

// per_device / per_seat quantities are resolved by the generator at billing
// time from live counts — the editor intentionally does not fetch them.
const AUTO_QTY_TYPES = new Set<ContractLineType>(['per_device', 'per_seat']);

const INTERVAL_PRESETS = [
  { value: 1, label: 'Monthly' },
  { value: 3, label: 'Quarterly' },
  { value: 12, label: 'Annual' },
];

interface Props {
  /** Present in edit mode (existing draft/active contract); absent when creating. */
  detail?: ContractDetail;
  /** Pre-select an org when creating (e.g. deep-linked from the org Contracts tab). */
  presetOrgId?: string;
  /** Called after a successful mutation so the parent can reload. */
  onChanged?: () => void;
}

export default function ContractEditor({ detail, presetOrgId, onChanged }: Props) {
  const { can } = usePermissions();
  const isCreate = !detail;
  const contract = detail?.contract;

  const [busy, setBusy] = useState(false);

  // ---- header form ---------------------------------------------------------
  const [orgId, setOrgId] = useState(contract?.orgId ?? presetOrgId ?? '');
  const [name, setName] = useState(contract?.name ?? '');
  const [billingTiming, setBillingTiming] = useState<ContractBillingTiming>(contract?.billingTiming ?? 'advance');
  const [intervalMonths, setIntervalMonths] = useState<number>(contract?.intervalMonths ?? 1);
  const [intervalCustom, setIntervalCustom] = useState(
    contract && ![1, 3, 12].includes(contract.intervalMonths),
  );
  const [startDate, setStartDate] = useState(
    contract?.startDate ?? new Date().toISOString().slice(0, 10),
  );
  const [endDate, setEndDate] = useState(contract?.endDate ?? '');
  const [autoIssue, setAutoIssue] = useState(contract?.autoIssue ?? false);
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [terms, setTerms] = useState(contract?.terms ?? '');
  const [liveEstimate, setLiveEstimate] = useState<ContractEstimate | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);

  // ---- reference data ------------------------------------------------------
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);

  // ---- add-line form -------------------------------------------------------
  const [lineType, setLineType] = useState<ContractLineType>('flat');
  const [lineDesc, setLineDesc] = useState('');
  const [linePrice, setLinePrice] = useState('0.00');
  const [lineQty, setLineQty] = useState('1');
  const [lineTaxable, setLineTaxable] = useState(false);
  const [lineSiteId, setLineSiteId] = useState('');
  const [lineCatalogId, setLineCatalogId] = useState('');

  const lines: ContractLine[] = detail?.lines ?? [];

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations');
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load organizations.'); return; }
    const body = (await res.json().catch(() => null)) as { data?: Organization[]; organizations?: Organization[] } | null;
    if (!body) return;
    setOrgs(body.data ?? body.organizations ?? []);
  }, []);

  const loadCatalog = useCallback(async () => {
    const res = await listCatalog({ isActive: true, limit: 200 });
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) return; // catalog is optional context; don't block the editor
    const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
    if (!body) return;
    setCatalogItems((body.data ?? []).filter((i) => !i.isBundle));
  }, []);

  const loadSites = useCallback(async (forOrg: string) => {
    if (!forOrg) { setSites([]); return; }
    const res = await fetchWithAuth(`/orgs/sites?organizationId=${forOrg}`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load sites.'); setSites([]); return; }
    const body = await res.json().catch(() => null);
    setSites(Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []);
  }, []);

  const loadEstimate = useCallback(async () => {
    if (!contract) return;
    let res: Response;
    try {
      res = await getContractEstimate(contract.id);
    } catch {
      setEstimateFailed(true); return;
    }
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { setEstimateFailed(true); return; }
    const body = (await res.json().catch(() => null)) as { data?: ContractEstimate } | null;
    setEstimateFailed(false);
    setLiveEstimate(body?.data ?? null);
  }, [contract]);

  useEffect(() => { if (isCreate) void loadOrgs(); }, [isCreate, loadOrgs]);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { void loadSites(orgId); }, [orgId, loadSites]);
  useEffect(() => { if (!isCreate) void loadEstimate(); }, [isCreate, loadEstimate]);

  const intervalIsValid = intervalMonths >= 1 && intervalMonths <= 60;
  const canSaveHeader = !!orgId && name.trim().length > 0 && !!startDate && intervalIsValid;

  // ---- live "Estimated this period" ----------------------------------------
  // flat/manual contribute qty×price; per_device/per_seat are resolved by the
  // generator from live counts, so we surface them as "auto" without a number.
  const estimate = useMemo(() => {
    let known = 0;
    let hasAuto = false;
    for (const l of lines) {
      if (AUTO_QTY_TYPES.has(l.lineType)) { hasAuto = true; continue; }
      const qty = l.lineType === 'manual' ? Number(l.manualQuantity ?? '0') : 1;
      known += qty * Number(l.unitPrice);
    }
    return { known, hasAuto };
  }, [lines]);

  // Resolved live quantity per line (per_device/per_seat) from the estimate.
  const estByLine = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of liveEstimate?.lines ?? []) m.set(e.lineId, e.quantity);
    return m;
  }, [liveEstimate]);

  const newLineEstimate = useMemo(() => {
    if (AUTO_QTY_TYPES.has(lineType)) return null;
    const qty = lineType === 'manual' ? Number(lineQty || '0') : 1;
    return qty * Number(linePrice || '0');
  }, [lineType, lineQty, linePrice]);

  const refresh = useCallback(() => { onChanged?.(); void loadEstimate(); }, [onChanged, loadEstimate]);

  // ---- create flow ---------------------------------------------------------
  const saveCreate = useCallback(async () => {
    if (busy || !canSaveHeader) return;
    setBusy(true);
    try {
      const result = await runAction<{ data: { id: string } }>({
        request: () => createContract({
          orgId,
          name: name.trim(),
          billingTiming,
          intervalMonths,
          startDate,
          endDate: endDate || null,
          autoIssue,
          notes: notes.trim() || null,
          terms: terms.trim() || null,
        }),
        errorFallback: 'Could not create the contract.',
        successMessage: 'Contract created',
        onUnauthorized: UNAUTHORIZED,
      });
      const newId = result?.data?.id;
      if (newId) void navigateTo(`/contracts/${newId}`);
    } catch (err) {
      handleActionError(err, 'Could not create the contract.');
    } finally {
      setBusy(false);
    }
  }, [busy, canSaveHeader, orgId, name, billingTiming, intervalMonths, startDate, endDate, autoIssue, notes, terms]);

  // ---- edit flow -----------------------------------------------------------
  const saveHeader = useCallback(async () => {
    if (busy || !contract || !canSaveHeader) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateContract(contract.id, {
          name: name.trim(),
          billingTiming,
          intervalMonths,
          startDate,
          endDate: endDate || null,
          autoIssue,
          notes: notes.trim() || null,
          terms: terms.trim() || null,
        }),
        errorFallback: 'Could not save the contract.',
        successMessage: 'Contract saved',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not save the contract.');
    } finally {
      setBusy(false);
    }
  }, [busy, contract, canSaveHeader, name, billingTiming, intervalMonths, startDate, endDate, autoIssue, notes, terms, refresh]);

  const addLine = useCallback(async () => {
    if (busy || !contract || !lineDesc.trim()) return;
    setBusy(true);
    try {
      await runAction({
        request: () => addContractLine(contract.id, {
          lineType,
          description: lineDesc.trim(),
          // unitPrice/manualQuantity are money strings (see contractLineInputSchema);
          // omit absent optionals (undefined) rather than sending null, which the
          // string-typed schema rejects.
          unitPrice: linePrice,
          manualQuantity: lineType === 'manual' ? lineQty : undefined,
          siteId: lineType === 'per_device' && lineSiteId ? lineSiteId : undefined,
          catalogItemId: lineCatalogId || undefined,
          taxable: lineTaxable,
        }),
        errorFallback: 'Could not add the line.',
        successMessage: 'Line added',
        onUnauthorized: UNAUTHORIZED,
      });
      setLineDesc(''); setLinePrice('0.00'); setLineQty('1');
      setLineTaxable(false); setLineSiteId(''); setLineCatalogId('');
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not add the line.');
    } finally {
      setBusy(false);
    }
  }, [busy, contract, lineType, lineDesc, linePrice, lineQty, lineSiteId, lineCatalogId, lineTaxable, refresh]);

  const removeLine = useCallback(async (lineId: string) => {
    if (busy || !contract) return;
    setBusy(true);
    try {
      await runAction({
        request: () => removeContractLine(contract.id, lineId),
        errorFallback: 'Could not remove the line.',
        successMessage: 'Line removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not remove the line.');
    } finally {
      setBusy(false);
    }
  }, [busy, contract, refresh]);

  const activate = useCallback(async () => {
    if (busy || !contract) return;
    setBusy(true);
    try {
      await runAction({
        request: () => contractTransition(contract.id, 'activate'),
        errorFallback: 'Could not activate the contract.',
        successMessage: 'Contract activated',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not activate the contract.');
    } finally {
      setBusy(false);
    }
  }, [busy, contract, refresh]);

  const siteName = useCallback(
    (id: string | null) => (id ? sites.find((s) => s.id === id)?.name ?? id.slice(0, 8) : null),
    [sites],
  );

  return (
    <div className="space-y-6" data-testid="contract-editor">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── header form + lines ─────────────────────────────────────── */}
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-header-form">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contract</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {isCreate && (
                <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                  Organization
                  <select
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value)}
                    data-testid="contract-form-org"
                    className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Select an organization…</option>
                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                Name
                <input
                  type="text" value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Managed Services — Acme Co"
                  data-testid="contract-form-name"
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Billing timing
                <select
                  value={billingTiming} onChange={(e) => setBillingTiming(e.target.value as ContractBillingTiming)}
                  data-testid="contract-form-timing"
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="advance">In advance</option>
                  <option value="arrears">In arrears</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Billing cadence
                <select
                  value={intervalCustom ? 'custom' : String(intervalMonths)}
                  onChange={(e) => {
                    if (e.target.value === 'custom') { setIntervalCustom(true); return; }
                    setIntervalCustom(false);
                    setIntervalMonths(Number(e.target.value));
                  }}
                  data-testid="contract-form-interval"
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {INTERVAL_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  <option value="custom">Custom…</option>
                </select>
              </label>
              {intervalCustom && (
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Interval (months)
                  <input
                    type="number" min="1" max="60" value={intervalMonths}
                    onChange={(e) => setIntervalMonths(Number(e.target.value))}
                    data-testid="contract-form-interval-custom"
                    className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Start date
                <input
                  type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  data-testid="contract-form-start"
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                End date (optional)
                <input
                  type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  data-testid="contract-form-end"
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox" checked={autoIssue} onChange={(e) => setAutoIssue(e.target.checked)}
                  data-testid="contract-form-auto-issue"
                />
                Auto-issue generated invoices (otherwise they land as drafts)
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                Notes (optional)
                <textarea
                  value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                  data-testid="contract-form-notes"
                  className="rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                Terms (optional, shown on the invoice)
                <textarea
                  value={terms} onChange={(e) => setTerms(e.target.value)} rows={2}
                  data-testid="contract-form-terms"
                  placeholder="e.g. Net 30. Auto-renews unless cancelled 30 days prior."
                  className="rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            </div>
          </div>

          {/* Lines (edit mode only — a contract needs an id before lines attach) */}
          {!isCreate && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-card shadow-sm">
                <table className="w-full text-sm" data-testid="contract-editor-lines">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Unit price</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-center font-medium">Tax</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                          No lines yet. Add a recurring line below.
                        </td>
                      </tr>
                    ) : (
                      lines.map((l, idx) => (
                        <tr key={l.id} className="border-t" data-testid={`line-row-${idx}`}>
                          <td className="px-3 py-2">
                            {LINE_TYPE_LABELS[l.lineType]}
                            {l.lineType === 'per_device' && l.siteId
                              ? <span className="block text-xs text-muted-foreground">{siteName(l.siteId)}</span>
                              : null}
                          </td>
                          <td className="px-3 py-2">{l.description}</td>
                          <td className="px-3 py-2 text-right">{formatMoney(l.unitPrice, contract?.currencyCode)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {AUTO_QTY_TYPES.has(l.lineType)
                              ? (estByLine.has(l.id)
                                  ? estByLine.get(l.id)
                                  : <span className="text-muted-foreground">auto</span>)
                              : (l.lineType === 'manual' ? (l.manualQuantity ?? '0') : '1')}
                          </td>
                          <td className="px-3 py-2 text-center">{l.taxable ? '✓' : '—'}</td>
                          <td className="px-3 py-2 text-right">
                            {can('contracts', 'write') && (
                              <button
                                type="button" onClick={() => void removeLine(l.id)} disabled={busy}
                                data-testid={`line-remove-${idx}`}
                                className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Add line */}
              <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-add-line">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Line type
                    <select
                      value={lineType}
                      onChange={(e) => { setLineType(e.target.value as ContractLineType); setLineSiteId(''); }}
                      data-testid="contract-line-type"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {(Object.keys(LINE_TYPE_LABELS) as ContractLineType[]).map((t) => (
                        <option key={t} value={t}>{LINE_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Description
                    <input
                      type="text" value={lineDesc} onChange={(e) => setLineDesc(e.target.value)}
                      placeholder="e.g. Workstation management"
                      data-testid="contract-line-desc"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Unit price
                    <input
                      type="number" min="0" step="0.01" value={linePrice}
                      onChange={(e) => setLinePrice(e.target.value)}
                      data-testid="contract-line-price"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  {lineType === 'manual' && (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Quantity
                      <input
                        type="number" min="0" step="0.01" value={lineQty}
                        onChange={(e) => setLineQty(e.target.value)}
                        data-testid="contract-line-qty"
                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </label>
                  )}
                  {lineType === 'per_device' && (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Site (optional — scopes the device count)
                      <select
                        value={lineSiteId} onChange={(e) => setLineSiteId(e.target.value)}
                        data-testid="contract-line-site"
                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">All sites</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </label>
                  )}
                  {catalogItems.length > 0 && (
                    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Link catalog item (optional)
                      {lineCatalogId ? (
                        <span className="inline-flex h-9 items-center gap-1.5 self-start rounded-md border bg-muted/40 px-2.5 text-sm text-foreground" data-testid="contract-line-catalog-picked">
                          <span className="font-medium">{catalogItems.find((i) => i.id === lineCatalogId)?.name ?? 'Item'}</span>
                          <button type="button" onClick={() => setLineCatalogId('')} aria-label="Clear catalog link" className="ml-1 text-muted-foreground hover:text-foreground">×</button>
                        </span>
                      ) : (
                        <CatalogItemPicker
                          items={catalogItems}
                          includeBundles={false}
                          onSelect={(it) => {
                            setLineCatalogId(it.id);
                            if (!lineDesc.trim()) setLineDesc(it.name);
                            setLinePrice(it.unitPrice);
                          }}
                          testId="contract-line-catalog-picker"
                          placeholder="Search catalog…"
                        />
                      )}
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox" checked={lineTaxable} onChange={(e) => setLineTaxable(e.target.checked)}
                      data-testid="contract-line-taxable"
                    />
                    Taxable
                  </label>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {newLineEstimate === null
                      ? 'Quantity resolved automatically at billing time.'
                      : `Line total: ${formatMoney(newLineEstimate, contract?.currencyCode)}`}
                  </span>
                  {can('contracts', 'write') && (
                    <button
                      type="button" onClick={() => void addLine()} disabled={busy || !lineDesc.trim()}
                      data-testid="add-line-btn"
                      className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Add line
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── summary + actions ───────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-estimate">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Estimated this period</h3>
            {isCreate ? (
              <p className="text-sm text-muted-foreground">Save the contract, then add lines to see an estimate.</p>
            ) : (
              <>
                <p className="text-2xl font-semibold tabular-nums" data-testid="contract-estimate-total">
                  {liveEstimate
                    ? formatMoney(liveEstimate.periodTotal, contract?.currencyCode)
                    : formatMoney(estimate.known, contract?.currencyCode)}
                  {!liveEstimate && estimate.hasAuto && (
                    <span className="ml-1 align-middle text-sm font-normal text-muted-foreground">+ auto</span>
                  )}
                </p>
                {liveEstimate && liveEstimate.lines.some((l) => l.live) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Includes live device / seat counts as of today.
                  </p>
                )}
                {!liveEstimate && estimateFailed && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-500" data-testid="contract-estimate-stale">
                    Couldn&rsquo;t load live counts{estimate.hasAuto ? ' — per-device/seat lines are not included in this total.' : '.'}{' '}
                    <button type="button" onClick={() => void loadEstimate()} className="underline hover:text-foreground">Retry</button>
                  </p>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            {isCreate ? (
              can('contracts', 'write') && (
                <button
                  type="button" onClick={() => void saveCreate()} disabled={busy || !canSaveHeader}
                  data-testid="save-contract-btn"
                  className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Create contract
                </button>
              )
            ) : (
              <>
                {can('contracts', 'write') && (
                  <button
                    type="button" onClick={() => void saveHeader()} disabled={busy || !canSaveHeader}
                    data-testid="save-contract-btn"
                    className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                  >
                    Save changes
                  </button>
                )}
                {can('contracts', 'manage') && contract?.status === 'draft' && (
                  <button
                    type="button" onClick={() => void activate()} disabled={busy || lines.length === 0}
                    data-testid="activate-contract-btn"
                    className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    Activate contract
                  </button>
                )}
                {contract?.status === 'draft' && lines.length === 0 && (
                  <p className="text-center text-xs text-muted-foreground" data-testid="contract-activate-hint">
                    Add at least one line to activate.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
