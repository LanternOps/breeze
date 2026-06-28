import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import {
  createContract,
  updateContract,
  addContractLine,
  updateContractLine,
  removeContractLine,
  contractTransition,
  getContractEstimate,
  formatCadenceAdverb,
  type ContractBillingTiming,
  type ContractDetail,
  type ContractLine,
  type ContractLineType,
  type ContractEstimate,
} from '../../lib/api/contracts';
import CatalogItemPicker from '../catalog/CatalogItemPicker';
import SearchableSelect from '../shared/SearchableSelect';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import Spinner from '../shared/Spinner';
import { listCatalog, type CatalogItem } from '../../lib/api/catalog';
import { formatMoney } from '../billing/invoiceTypes';
import { usePermissions } from '../../lib/permissions';

interface Organization { id: string; name: string }
interface Site { id: string; name: string }

/** The subset the lines table + estimate read. In edit mode these are persisted
 *  ContractLines; in create mode they're lines staged locally before the
 *  contract exists, committed atomically with the create. */
type LineView = Pick<ContractLine, 'id' | 'lineType' | 'description' | 'unitPrice' | 'manualQuantity' | 'siteId' | 'taxable' | 'catalogItemId'>;

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

  // Which mutation is in flight, so the active button (not all of them) shows a
  // spinner + verb. null = idle; `busy` is derived for the existing disable
  // guards so every in-flight path still blocks concurrent mutations.
  const [pending, setPending] = useState<null | 'create' | 'save' | 'addLine' | 'editLine' | 'removeLine' | 'activate'>(null);
  const busy = pending !== null;

  // Confirmation gates for the two irreversible money-moments: removing a
  // billing line and activating (which starts real invoice generation).
  const [removeTarget, setRemoveTarget] = useState<LineView | null>(null);
  const [confirmActivate, setConfirmActivate] = useState(false);

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
  const [autoRenew, setAutoRenew] = useState<boolean>(contract?.autoRenew ?? false);
  const [renewalTermMonths, setRenewalTermMonths] = useState<string>(contract?.renewalTermMonths != null ? String(contract.renewalTermMonths) : '');
  const [renewalNoticeDays, setRenewalNoticeDays] = useState<string>(contract?.renewalNoticeDays != null ? String(contract.renewalNoticeDays) : '30');
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
  // Set while editing an existing line in place; the add-line form becomes the
  // editor (Save line / Cancel) instead of adding a new row.
  const [editingLineId, setEditingLineId] = useState<string | null>(null);

  // Lines staged locally in create mode (no contract id yet); committed
  // atomically with the contract on save. Edit mode reads persisted lines.
  const [draftLines, setDraftLines] = useState<LineView[]>([]);
  const lines: LineView[] = isCreate ? draftLines : (detail?.lines ?? []);

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
  // ISO yyyy-mm-dd compares lexicographically === chronologically.
  const dateRangeValid = !endDate || endDate > startDate;
  const canSaveHeader = !!orgId && name.trim().length > 0 && !!startDate && intervalIsValid && dateRangeValid;

  // First unmet requirement, surfaced under the disabled save button so the user
  // never has to guess why it's greyed out.
  const missingHint = !orgId
    ? 'Select an organization to save.'
    : name.trim().length === 0
      ? 'Add a contract name to save.'
      : !startDate
        ? 'Set a start date to save.'
        : !intervalIsValid
          ? 'Enter a billing interval of 1–60 months.'
          : !dateRangeValid
            ? 'End date must be after the start date.'
            : null;

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

  // ---- create-mode line staging (local; committed with the create) ----------
  const addDraftLine = useCallback(() => {
    if (!lineDesc.trim()) return;
    setDraftLines((prev) => [...prev, {
      id: crypto.randomUUID(),
      lineType,
      description: lineDesc.trim(),
      unitPrice: linePrice,
      manualQuantity: lineType === 'manual' ? lineQty : null,
      siteId: lineType === 'per_device' ? (lineSiteId || null) : null,
      catalogItemId: lineCatalogId || null,
      taxable: lineTaxable,
    }]);
    setLineDesc(''); setLinePrice('0.00'); setLineQty('1');
    setLineTaxable(false); setLineSiteId(''); setLineCatalogId('');
  }, [lineType, lineDesc, linePrice, lineQty, lineSiteId, lineCatalogId, lineTaxable]);

  // Staged lines aren't persisted yet, so removal is instant (no confirm —
  // unlike edit mode, where Remove deletes a real billing line).
  const removeDraftLine = useCallback((id: string) => {
    setDraftLines((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const resetLineForm = useCallback(() => {
    setLineType('flat'); setLineDesc(''); setLinePrice('0.00'); setLineQty('1');
    setLineTaxable(false); setLineSiteId(''); setLineCatalogId('');
  }, []);

  // Load an existing line into the add-line form, turning it into an editor.
  const startEditLine = useCallback((l: LineView) => {
    setLineType(l.lineType);
    setLineDesc(l.description);
    setLinePrice(l.unitPrice);
    setLineQty(l.manualQuantity ?? '1');
    setLineSiteId(l.siteId ?? '');
    setLineCatalogId(l.catalogItemId ?? '');
    setLineTaxable(l.taxable);
    setEditingLineId(l.id);
  }, []);

  const cancelEditLine = useCallback(() => {
    resetLineForm();
    setEditingLineId(null);
  }, [resetLineForm]);

  // The current add-line form values as a LineView body (sans id).
  const currentLineFields = useCallback((): Omit<LineView, 'id'> => ({
    lineType,
    description: lineDesc.trim(),
    unitPrice: linePrice,
    manualQuantity: lineType === 'manual' ? lineQty : null,
    siteId: lineType === 'per_device' ? (lineSiteId || null) : null,
    catalogItemId: lineCatalogId || null,
    taxable: lineTaxable,
  }), [lineType, lineDesc, linePrice, lineQty, lineSiteId, lineCatalogId, lineTaxable]);

  // The same values shaped for the line API (omit absent optionals).
  const currentLineInput = useCallback(() => ({
    lineType,
    description: lineDesc.trim(),
    unitPrice: linePrice,
    taxable: lineTaxable,
    ...(lineType === 'manual' ? { manualQuantity: lineQty } : {}),
    ...(lineType === 'per_device' && lineSiteId ? { siteId: lineSiteId } : {}),
    ...(lineCatalogId ? { catalogItemId: lineCatalogId } : {}),
  }), [lineType, lineDesc, linePrice, lineQty, lineSiteId, lineCatalogId, lineTaxable]);

  // Save an in-place edit: local for staged (create) lines, PATCH for persisted.
  const saveEditLine = useCallback(async () => {
    if (!editingLineId || !lineDesc.trim()) return;
    if (isCreate) {
      const fields = currentLineFields();
      setDraftLines((prev) => prev.map((dl) => dl.id === editingLineId ? { id: dl.id, ...fields } : dl));
      cancelEditLine();
      return;
    }
    if (busy || !contract) return;
    setPending('editLine');
    try {
      await runAction({
        request: () => updateContractLine(contract.id, editingLineId, currentLineInput()),
        errorFallback: 'Could not update the line.',
        successMessage: 'Line updated',
        onUnauthorized: UNAUTHORIZED,
      });
      cancelEditLine();
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not update the line.');
    } finally {
      setPending(null);
    }
  }, [editingLineId, lineDesc, isCreate, busy, contract, currentLineFields, currentLineInput, cancelEditLine, refresh]);

  /** Map staged lines to the contractLineInputSchema shape (omit absent
   *  optionals rather than sending null, which the string schema rejects). */
  const draftLinePayload = useCallback(() => draftLines.map((l) => ({
    lineType: l.lineType,
    description: l.description,
    unitPrice: l.unitPrice,
    taxable: l.taxable,
    ...(l.lineType === 'manual' ? { manualQuantity: l.manualQuantity ?? '0' } : {}),
    ...(l.lineType === 'per_device' && l.siteId ? { siteId: l.siteId } : {}),
    ...(l.catalogItemId ? { catalogItemId: l.catalogItemId } : {}),
  })), [draftLines]);

  // ---- create flow ---------------------------------------------------------
  const saveCreate = useCallback(async () => {
    if (busy || !canSaveHeader) return;
    setPending('create');
    try {
      if (autoRenew && !renewalTermMonths) {
        showToast({ type: 'error', message: 'Enter a renewal term (months) before saving.' });
        return;
      }
      const result = await runAction<{ data: { id: string } }>({
        request: () => createContract({
          orgId,
          name: name.trim(),
          billingTiming,
          intervalMonths,
          startDate,
          endDate: endDate || null,
          autoIssue,
          autoRenew,
          renewalTermMonths: autoRenew ? Number(renewalTermMonths) : null,
          renewalNoticeDays: autoRenew ? (renewalNoticeDays === '' ? null : Number(renewalNoticeDays)) : null,
          notes: notes.trim() || null,
          terms: terms.trim() || null,
          // Commit staged lines atomically with the contract; on failure nothing
          // persists and the staged lines stay in the form for a retry.
          lines: draftLinePayload(),
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
      setPending(null);
    }
  }, [busy, canSaveHeader, orgId, name, billingTiming, intervalMonths, startDate, endDate, autoIssue, autoRenew, renewalTermMonths, renewalNoticeDays, notes, terms, draftLinePayload]);

  // ---- edit flow -----------------------------------------------------------
  const saveHeader = useCallback(async () => {
    if (busy || !contract || !canSaveHeader) return;
    setPending('save');
    try {
      if (autoRenew && !renewalTermMonths) {
        showToast({ type: 'error', message: 'Enter a renewal term (months) before saving.' });
        return;
      }
      await runAction({
        request: () => updateContract(contract.id, {
          name: name.trim(),
          billingTiming,
          intervalMonths,
          startDate,
          endDate: endDate || null,
          autoIssue,
          autoRenew,
          renewalTermMonths: autoRenew ? Number(renewalTermMonths) : null,
          renewalNoticeDays: autoRenew ? (renewalNoticeDays === '' ? null : Number(renewalNoticeDays)) : null,
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
      setPending(null);
    }
  }, [busy, contract, canSaveHeader, name, billingTiming, intervalMonths, startDate, endDate, autoIssue, autoRenew, renewalTermMonths, renewalNoticeDays, notes, terms, refresh]);

  const addLine = useCallback(async () => {
    if (busy || !contract || !lineDesc.trim()) return;
    setPending('addLine');
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
      setPending(null);
    }
  }, [busy, contract, lineType, lineDesc, linePrice, lineQty, lineSiteId, lineCatalogId, lineTaxable, refresh]);

  const removeLine = useCallback(async (lineId: string) => {
    if (busy || !contract) return;
    setPending('removeLine');
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
      setPending(null);
    }
  }, [busy, contract, refresh]);

  const activate = useCallback(async () => {
    if (busy || !contract) return;
    setPending('activate');
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
      setPending(null);
    }
  }, [busy, contract, refresh]);

  const siteName = useCallback(
    (id: string | null) => (id ? sites.find((s) => s.id === id)?.name ?? id.slice(0, 8) : null),
    [sites],
  );

  // Linked catalog item (if any) and whether the entered unit price diverges
  // from it, so we can warn instead of silently letting the two disagree.
  const linkedCatalogItem = useMemo(
    () => catalogItems.find((i) => i.id === lineCatalogId) ?? null,
    [catalogItems, lineCatalogId],
  );
  const catalogPriceMismatch =
    linkedCatalogItem != null && Number(linkedCatalogItem.unitPrice) !== Number(linePrice || '0');

  return (
    <div className="space-y-6" data-testid="contract-editor">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── header form + lines ─────────────────────────────────────── */}
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-header-form">
            <div className="space-y-5">
              {/* Identity */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {isCreate && (
                  <div className="flex flex-col gap-1 text-xs font-medium text-foreground/85 sm:col-span-2">
                    Organization
                    <SearchableSelect
                      options={orgs}
                      value={orgId}
                      onChange={setOrgId}
                      placeholder="Search organizations…"
                      ariaLabel="Organization"
                      testId="contract-form-org"
                    />
                  </div>
                )}
                <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85 sm:col-span-2">
                  Name
                  <input
                    type="text" value={name} onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Managed Services — Acme Co"
                    data-testid="contract-form-name"
                    className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
              </div>

              {/* Billing schedule */}
              <fieldset className="m-0 space-y-3 border-0 p-0">
                <legend className="mb-1 p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billing schedule</legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
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
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
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
                    <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                      Interval (months)
                      <input
                        type="number" min="1" max="60" value={intervalMonths}
                        onChange={(e) => setIntervalMonths(Number(e.target.value))}
                        data-testid="contract-form-interval-custom"
                        className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                    Start date
                    <input
                      type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                      data-testid="contract-form-start"
                      className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                    End date (optional)
                    <input
                      type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); if (!e.target.value) setAutoRenew(false); }}
                      data-testid="contract-form-end"
                      className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                </div>
              </fieldset>

              {/* Renewal & issuing */}
              <fieldset className="m-0 space-y-3 border-0 p-0">
                <legend className="mb-1 p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Renewal &amp; issuing</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox" checked={autoIssue} onChange={(e) => setAutoIssue(e.target.checked)}
                    data-testid="contract-form-auto-issue"
                  />
                  Auto-issue generated invoices (otherwise they land as drafts)
                </label>
                <div>
                  <label className="flex items-center gap-2 text-sm" data-testid="contract-auto-renew-toggle">
                    <input
                      type="checkbox" checked={autoRenew} disabled={!endDate}
                      onChange={(e) => setAutoRenew(e.target.checked)}
                    />
                    <span>Auto-renew at end of term{!endDate ? ' (set an end date first)' : ''}</span>
                  </label>
                  {autoRenew && (
                    <div className="mt-2 grid grid-cols-2 gap-3" data-testid="contract-renewal-fields">
                      <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                        Renewal term (months)
                        <input
                          type="number" min={1} max={120} value={renewalTermMonths}
                          onChange={(e) => setRenewalTermMonths(e.target.value)}
                          data-testid="contract-renewal-term"
                          className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                        Advance notice (days)
                        <input
                          type="number" min={0} max={365} value={renewalNoticeDays}
                          onChange={(e) => setRenewalNoticeDays(e.target.value)}
                          data-testid="contract-renewal-notice-days"
                          className="h-10 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                    </div>
                  )}
                </div>
              </fieldset>

              {/* Invoice text */}
              <fieldset className="m-0 space-y-3 border-0 p-0">
                <legend className="mb-1 p-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invoice text</legend>
                <div className="grid grid-cols-1 gap-3">
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                    Notes (optional)
                    <textarea
                      value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                      data-testid="contract-form-notes"
                      className="rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                    Terms (optional, shown on the invoice)
                    <textarea
                      value={terms} onChange={(e) => setTerms(e.target.value)} rows={2}
                      data-testid="contract-form-terms"
                      placeholder="e.g. Net 30. Auto-renews unless cancelled 30 days prior."
                      className="rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                </div>
              </fieldset>
            </div>
          </div>

          {/* Lines — staged locally in create mode, persisted in edit mode */}
          <div className="space-y-4">
              <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
                <table className="w-full min-w-[34rem] text-sm" data-testid="contract-editor-lines">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Unit price</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-center font-medium">Tax</th>
                      <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
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
                          <td className="px-3 py-2 text-center">
                            <span aria-hidden="true">{l.taxable ? '✓' : '—'}</span>
                            <span className="sr-only">{l.taxable ? 'Taxable' : 'Not taxable'}</span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            {can('contracts', 'write') && (
                              <div className="flex justify-end gap-1">
                                <button
                                  type="button" onClick={() => startEditLine(l)} disabled={busy}
                                  data-testid={`line-edit-${idx}`}
                                  aria-current={editingLineId === l.id ? 'true' : undefined}
                                  className={`rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50 ${editingLineId === l.id ? 'border-primary text-primary' : ''}`}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button" onClick={() => isCreate ? removeDraftLine(l.id) : setRemoveTarget(l)} disabled={busy}
                                  data-testid={`line-remove-${idx}`}
                                  className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Add / edit line */}
              <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-add-line">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground" data-testid="contract-line-form-title">
                  {editingLineId ? 'Edit line' : 'Add a line'}
                </h4>
                {/* What's being billed */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
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
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                    Description
                    <input
                      type="text" value={lineDesc} onChange={(e) => setLineDesc(e.target.value)}
                      placeholder="e.g. Workstation management"
                      data-testid="contract-line-desc"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  {catalogItems.length > 0 && (
                    <div className="flex flex-col gap-1 text-xs font-medium text-foreground/85 sm:col-span-2">
                      Link catalog item (optional)
                      {lineCatalogId ? (
                        <div className="flex flex-col gap-1" data-testid="contract-line-catalog-picked">
                          <span className="inline-flex h-9 items-center gap-1 self-start rounded-md border bg-muted/40 pl-2.5 pr-1 text-sm text-foreground">
                            <span className="font-medium">{linkedCatalogItem?.name ?? 'Item'}</span>
                            <button
                              type="button" onClick={() => setLineCatalogId('')}
                              aria-label="Clear catalog link"
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-base leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              ×
                            </button>
                          </span>
                          {catalogPriceMismatch && linkedCatalogItem && (
                            <span className="text-[11px] font-normal text-amber-600 dark:text-amber-500" data-testid="contract-line-catalog-price-note">
                              Catalog lists {formatMoney(linkedCatalogItem.unitPrice, contract?.currencyCode)} — keeping your entered price.
                            </span>
                          )}
                        </div>
                      ) : (
                        <CatalogItemPicker
                          items={catalogItems}
                          includeBundles={false}
                          onSelect={(it) => {
                            setLineCatalogId(it.id);
                            if (!lineDesc.trim()) setLineDesc(it.name);
                            // Don't clobber a price the user already typed (e.g. a
                            // negotiated rate); only fill from the catalog when the
                            // field is still at its default.
                            if (linePrice === '' || Number(linePrice) === 0) setLinePrice(it.unitPrice);
                          }}
                          testId="contract-line-catalog-picker"
                          placeholder="Search catalog…"
                        />
                      )}
                    </div>
                  )}
                  {/* How much it costs */}
                  <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
                    Unit price
                    <input
                      type="number" min="0" step="0.01" value={linePrice}
                      onChange={(e) => setLinePrice(e.target.value)}
                      data-testid="contract-line-price"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  {lineType === 'manual' && (
                    <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
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
                    <label className="flex flex-col gap-1 text-xs font-medium text-foreground/85">
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
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <input
                      type="checkbox" checked={lineTaxable} onChange={(e) => setLineTaxable(e.target.checked)}
                      data-testid="contract-line-taxable"
                    />
                    Taxable
                  </label>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {newLineEstimate === null
                      ? 'Quantity resolved automatically at billing time.'
                      : `Line total: ${formatMoney(newLineEstimate, contract?.currencyCode)}`}
                  </span>
                  {can('contracts', 'write') && (
                    <div className="flex items-center gap-2">
                      {editingLineId && (
                        <button
                          type="button" onClick={cancelEditLine} disabled={busy}
                          data-testid="cancel-line-btn"
                          className="inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => editingLineId ? void saveEditLine() : (isCreate ? addDraftLine() : void addLine())}
                        disabled={busy || !lineDesc.trim()}
                        data-testid="add-line-btn"
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {(pending === 'addLine' || pending === 'editLine') && <Spinner />}
                        {editingLineId
                          ? (pending === 'editLine' ? 'Saving…' : 'Save line')
                          : (pending === 'addLine' ? 'Adding…' : 'Add line')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
          </div>
        </div>

        {/* ── summary + actions ───────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-4 shadow-sm" data-testid="contract-estimate">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Estimated this period</h3>
            {isCreate && lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a line to see the estimated total.</p>
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
                {!liveEstimate && !estimateFailed && estimate.hasAuto && (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="contract-estimate-auto-note">
                    Per-device / seat lines bill on live counts and aren&rsquo;t in this total.
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
                <>
                  <button
                    type="button" onClick={() => void saveCreate()} disabled={busy || !canSaveHeader}
                    data-testid="save-contract-btn"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {pending === 'create' && <Spinner />}
                    {pending === 'create' ? 'Creating…' : 'Create contract'}
                  </button>
                  {!canSaveHeader && missingHint && (
                    <p className="text-center text-xs text-muted-foreground" data-testid="contract-save-hint">{missingHint}</p>
                  )}
                </>
              )
            ) : (
              <>
                {can('contracts', 'write') && (
                  <>
                    <button
                      type="button" onClick={() => void saveHeader()} disabled={busy || !canSaveHeader}
                      data-testid="save-contract-btn"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {pending === 'save' && <Spinner />}
                      {pending === 'save' ? 'Saving…' : 'Save changes'}
                    </button>
                    {!canSaveHeader && missingHint && (
                      <p className="text-center text-xs text-muted-foreground" data-testid="contract-save-hint">{missingHint}</p>
                    )}
                  </>
                )}
                {can('contracts', 'manage') && contract?.status === 'draft' && (
                  <button
                    type="button" onClick={() => setConfirmActivate(true)} disabled={busy || lines.length === 0}
                    data-testid="activate-contract-btn"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-primary bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
                  >
                    {pending === 'activate' && <Spinner />}
                    {pending === 'activate' ? 'Activating…' : 'Activate contract'}
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

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => { const id = removeTarget?.id; setRemoveTarget(null); if (id) void removeLine(id); }}
        isLoading={busy}
        variant="destructive"
        title="Remove contract line"
        message={
          removeTarget
            ? `Remove "${removeTarget.description}" from this contract? This changes what the client is billed each period.`
            : ''
        }
        confirmLabel="Remove line"
        confirmTestId="contract-line-remove-confirm"
      />

      <ConfirmDialog
        open={confirmActivate}
        onClose={() => setConfirmActivate(false)}
        onConfirm={() => { setConfirmActivate(false); void activate(); }}
        isLoading={busy}
        variant="warning"
        title="Activate contract"
        message={
          `Activating starts billing for "${name.trim() || 'this contract'}". It will generate ` +
          `${liveEstimate ? formatMoney(liveEstimate.periodTotal, contract?.currencyCode) : formatMoney(estimate.known, contract?.currencyCode)}` +
          `${!liveEstimate && estimate.hasAuto ? ' plus auto-counted device/seat lines' : ''} ` +
          `${formatCadenceAdverb(intervalMonths)}, starting ${startDate ? new Date(`${startDate}T00:00:00`).toLocaleDateString() : 'the start date'}. ` +
          `${autoIssue ? 'Invoices are issued automatically.' : 'Invoices land as drafts for review.'}`
        }
        confirmLabel="Activate contract"
        confirmTestId="contract-activate-confirm"
      />
    </div>
  );
}
