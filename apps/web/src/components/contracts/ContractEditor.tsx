import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
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
import CatalogDistributorDrawer from '../settings/CatalogDistributorDrawer';
import Pax8CatalogDrawer from '../settings/Pax8CatalogDrawer';
import ContractPax8Drawer from './ContractPax8Drawer';
import { listCatalog, type CatalogItem } from '../../lib/api/catalog';
import { ecExpressStatus, pax8Status } from '../../lib/api/distributors';
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

// ── Save-grammar helpers (byte-similar local copies of the invoice/quote
//    editors' — kept inline per CLAUDE.md; a later pass may extract them). ──────

// Visually-hidden polite live region — announces a transient "Saved" to screen
// readers, pairing with the amber→green dirty-ring cue sighted users see.
function SrSaved({ show, label = 'Saved', testId }: { show: boolean; label?: string; testId?: string }) {
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only" data-testid={testId}>{show ? label : ''}</span>;
}

// A field's save-state outline: amber while unsaved, a brief green pulse when it
// lands, nothing at rest. It's a box-shadow (ring), so it never reflows
// neighbours. Pair with a constant `transition-shadow` on the field.
function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'ring-1 ring-warning' : saved ? 'ring-1 ring-success' : '';
}

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
  const canWrite = can('contracts', 'write');
  const isCreate = !detail;
  const contract = detail?.contract;
  // Schedule fields (billingTiming, intervalMonths, startDate) drive next_billing_at
  // and are draft-only server-side (PATCH 409s on a non-draft). Only offer them as
  // editable while creating or on a draft; otherwise render read-only.
  const scheduleEditable = isCreate || contract?.status === 'draft';

  const [busy, setBusy] = useState(false);

  // ---- header form ---------------------------------------------------------
  const [orgId, setOrgId] = useState(contract?.orgId ?? presetOrgId ?? '');
  const [name, setName] = useState(contract?.name ?? '');
  const [billingTiming, setBillingTiming] = useState<ContractBillingTiming>(contract?.billingTiming ?? 'advance');
  const [intervalMonths, setIntervalMonths] = useState<number>(contract?.intervalMonths ?? 1);
  const [intervalCustom, setIntervalCustom] = useState(
    contract ? ![1, 3, 12].includes(contract.intervalMonths) : false,
  );
  // Raw string for the custom-interval input so it can be emptied (an empty field
  // reads as invalid → inline error, not a silent snap-back to 0).
  const [customMonths, setCustomMonths] = useState<string>(String(contract?.intervalMonths ?? 1));
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

  // Guard an in-progress edit from being clobbered by a server resync mid-type:
  // the flag is set on keystroke and cleared when a commit is initiated (on
  // blur), so a background refresh landing mid-edit keeps the user's keystrokes
  // while a settled field re-adopts the server's canonical (e.g. trimmed) value
  // — mirrors the invoice/quote editors' edited-flag pattern. Selects/checkboxes
  // commit on the same event that changes them, so they resync unconditionally.
  const nameEdited = useRef(false);
  const startEdited = useRef(false);
  const endEdited = useRef(false);
  const notesEdited = useRef(false);
  const termsEdited = useRef(false);
  const renewalTermEdited = useRef(false);
  const renewalNoticeEdited = useRef(false);
  useEffect(() => { if (contract && !nameEdited.current) setName(contract.name); }, [contract?.name]);
  useEffect(() => { if (contract && !startEdited.current) setStartDate(contract.startDate); }, [contract?.startDate]);
  useEffect(() => { if (contract && !endEdited.current) setEndDate(contract.endDate ?? ''); }, [contract?.endDate]);
  useEffect(() => { if (contract && !notesEdited.current) setNotes(contract.notes ?? ''); }, [contract?.notes]);
  useEffect(() => { if (contract && !termsEdited.current) setTerms(contract.terms ?? ''); }, [contract?.terms]);
  useEffect(() => {
    if (contract && !renewalTermEdited.current) setRenewalTermMonths(contract.renewalTermMonths != null ? String(contract.renewalTermMonths) : '');
  }, [contract?.renewalTermMonths]);
  useEffect(() => {
    if (contract && !renewalNoticeEdited.current) setRenewalNoticeDays(contract.renewalNoticeDays != null ? String(contract.renewalNoticeDays) : '');
  }, [contract?.renewalNoticeDays]);
  useEffect(() => { if (contract) setAutoIssue(contract.autoIssue); }, [contract?.autoIssue]);
  useEffect(() => { if (contract) setAutoRenew(contract.autoRenew); }, [contract?.autoRenew]);
  useEffect(() => { if (contract) setBillingTiming(contract.billingTiming); }, [contract?.billingTiming]);
  useEffect(() => {
    if (!contract) return;
    setIntervalMonths(contract.intervalMonths);
    const custom = ![1, 3, 12].includes(contract.intervalMonths);
    setIntervalCustom(custom);
    if (custom) setCustomMonths(String(contract.intervalMonths));
  }, [contract?.intervalMonths]);

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
  // TD SYNNEX EC Express import, offered only when the integration is connected
  // (best-effort status check; stays hidden on any failure).
  const [ecActive, setEcActive] = useState(false);
  const [distributorOpen, setDistributorOpen] = useState(false);
  // Pax8 link entry — available once the partner's Pax8 integration is set up.
  const [pax8IntegrationId, setPax8IntegrationId] = useState<string | null>(null);
  const [pax8Open, setPax8Open] = useState(false);
  // Pax8 catalog import — distinct from subscription linking; needs only the integration.
  const [pax8CatalogOpen, setPax8CatalogOpen] = useState(false);
  const [pax8Active, setPax8Active] = useState(false);

  const lines: ContractLine[] = detail?.lines ?? [];

  // Line removal is irreversible, so it goes through a confirm step (mirrors the
  // quote/invoice editors) instead of deleting outright.
  const [pendingRemove, setPendingRemove] = useState<ContractLine | null>(null);

  // Per-field scoped pending + a keyed "Saved" flash, so one in-flight field save
  // never freezes its siblings and each field can pulse green on its own. Keys:
  // 'name', 'timing', 'interval', 'startDate', 'endDate', 'autoIssue',
  // 'autoRenew', 'renewalTerm', 'renewalNotice', 'notes', 'terms',
  // `remove-<lineId>`. `pending` drives disabled styling; `inFlight` is the
  // synchronous double-submit guard (state updates are async).
  const inFlight = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  const [savedKeys, setSavedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const savedTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => () => { savedTimers.current.forEach((t) => clearTimeout(t)); }, []);
  const flashSaved = useCallback((key: string) => {
    setSavedKeys((s) => { const n = new Set(s); n.add(key); return n; });
    const existing = savedTimers.current.get(key);
    if (existing) clearTimeout(existing);
    savedTimers.current.set(key, setTimeout(() => {
      setSavedKeys((s) => { const n = new Set(s); n.delete(key); return n; });
      savedTimers.current.delete(key);
    }, 1500));
  }, []);
  const isSaved = useCallback((key: string) => savedKeys.has(key), [savedKeys]);

  // Run a scoped mutation: mark the key pending, run, surface failures via the
  // standard handleActionError path, and always clear the key. Returns whether
  // the mutation succeeded so callers can flash a quiet "Saved" cue.
  const runScoped = useCallback(
    async (key: string, fn: () => Promise<void>, errMsg: string): Promise<boolean> => {
      if (inFlight.current.has(key)) return false;
      inFlight.current.add(key);
      setPending((s) => { const n = new Set(s); n.add(key); return n; });
      try {
        await fn();
        return true;
      } catch (err) {
        handleActionError(err, errMsg);
        return false;
      } finally {
        inFlight.current.delete(key);
        setPending((s) => { const n = new Set(s); n.delete(key); return n; });
      }
    },
    [],
  );

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

  // Load orgs in both modes: the create form needs the picker; the edit form
  // resolves the (immutable) org's display name for the read-only Schedule field.
  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  // Gate the distributor-import entry on a connected EC Express integration.
  useEffect(() => {
    if (!can('contracts', 'write')) return;
    void (async () => {
      try {
        const res = await ecExpressStatus();
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
        setEcActive(Boolean(body?.data?.configured && body?.data?.enabled));
      } catch { /* leave hidden */ }
    })();
  }, [can]);

  // Pax8 link entry is offered only when the integration exists. The GET returns
  // the integration row (or null/404 when unconfigured); best-effort, stays hidden
  // on failure.
  useEffect(() => {
    if (!can('contracts', 'write')) return;
    void (async () => {
      try {
        const res = await fetchWithAuth('/pax8/integration');
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { data?: { id?: string } | null } | null;
        if (body?.data?.id) setPax8IntegrationId(body.data.id);
      } catch { /* leave hidden */ }
    })();
  }, [can]);

  // Gate the Pax8 catalog-import entry on a connected + enabled Pax8 integration.
  useEffect(() => {
    if (!can('contracts', 'write')) return;
    void (async () => {
      try {
        const res = await pax8Status();
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
        setPax8Active(Boolean(body?.data?.configured && body?.data?.enabled));
      } catch { /* leave hidden */ }
    })();
  }, [can]);

  // Importing a distributor item to the catalog then pre-fills a one-time manual
  // line linked to the freshly-created catalog item.
  const onDistributorImported = useCallback((item: CatalogItem) => {
    setLineType('manual');
    setLineDesc(item.name);
    setLinePrice(item.unitPrice);
    setLineCatalogId(item.id);
    setLineTaxable(item.taxable);
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => { void loadSites(orgId); }, [orgId, loadSites]);
  useEffect(() => { if (!isCreate) void loadEstimate(); }, [isCreate, loadEstimate]);

  // Effective cadence in months: the custom text input when "Custom…" is chosen,
  // otherwise the selected preset. Validation covers the empty/non-integer/out-of-
  // range cases so the operator sees why, instead of a silently-disabled control.
  const effectiveMonths = intervalCustom ? Number(customMonths) : intervalMonths;
  const intervalValid = intervalCustom
    ? customMonths.trim() !== '' && Number.isInteger(effectiveMonths) && effectiveMonths >= 1 && effectiveMonths <= 60
    : intervalMonths >= 1 && intervalMonths <= 60;
  const intervalError = intervalCustom && !intervalValid ? 'Enter the number of months' : null;
  const canSaveHeader = !!orgId && name.trim().length > 0 && !!startDate && intervalValid;
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? orgId;

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
      if (autoRenew && !renewalTermMonths) {
        showToast({ type: 'error', message: 'Enter a renewal term (months) before saving.' });
        return;
      }
      const result = await runAction<{ data: { id: string } }>({
        request: () => createContract({
          orgId,
          name: name.trim(),
          billingTiming,
          intervalMonths: effectiveMonths,
          startDate,
          endDate: endDate || null,
          autoIssue,
          autoRenew,
          renewalTermMonths: autoRenew ? Number(renewalTermMonths) : null,
          renewalNoticeDays: autoRenew ? (renewalNoticeDays === '' ? null : Number(renewalNoticeDays)) : null,
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
  }, [busy, canSaveHeader, orgId, name, billingTiming, effectiveMonths, startDate, endDate, autoIssue, autoRenew, renewalTermMonths, renewalNoticeDays, notes, terms]);

  // ---- edit flow: per-field blur/change autosave ---------------------------
  // Each header field PATCHes independently (updateContractSchema is fully
  // partial). No per-field success toast — the amber→green ring + a single SR
  // "Saved" announcement are the feedback; failures fall through to
  // handleActionError. Selects/checkboxes commit on change; text/date/number
  // fields on blur (with the same guards the create/commit paths use).
  const savePatch = useCallback(async (patch: Record<string, unknown>, key: string) => {
    if (!contract) return;
    const ok = await runScoped(key, async () => {
      await runAction({
        request: () => updateContract(contract.id, patch),
        errorFallback: 'Could not save the contract.',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not save the contract.');
    if (ok) flashSaved(key);
  }, [contract, runScoped, refresh, flashSaved]);

  // Per-field dirty cues compare the live value against the persisted contract so
  // a successful save (which reloads `detail`) auto-clears the amber ring.
  const nameDirty = !isCreate && name !== (contract?.name ?? '');
  const startDirty = !isCreate && startDate !== (contract?.startDate ?? '');
  const endDirty = !isCreate && (endDate || '') !== (contract?.endDate ?? '');
  const intervalDirty = !isCreate && intervalCustom && intervalValid && effectiveMonths !== (contract?.intervalMonths ?? 0);
  const notesDirty = !isCreate && notes !== (contract?.notes ?? '');
  const termsDirty = !isCreate && terms !== (contract?.terms ?? '');
  const persistedTerm = contract?.renewalTermMonths != null ? String(contract.renewalTermMonths) : '';
  const persistedNotice = contract?.renewalNoticeDays != null ? String(contract.renewalNoticeDays) : '';
  const renewalTermDirty = !isCreate && renewalTermMonths !== persistedTerm;
  const renewalNoticeDirty = !isCreate && renewalNoticeDays !== persistedNotice;

  const commitName = useCallback(() => {
    if (!canWrite || isCreate) return;
    nameEdited.current = false; // committing — let the server value re-adopt next
    const next = name.trim();
    if (next === (contract?.name ?? '')) return;
    if (!next) { handleActionError(new Error('empty name'), 'Enter a contract name.'); return; }
    void savePatch({ name: next }, 'name');
  }, [canWrite, isCreate, name, contract, savePatch]);

  const commitStart = useCallback(() => {
    if (!canWrite || isCreate || !scheduleEditable) return;
    startEdited.current = false;
    if (startDate === (contract?.startDate ?? '')) return;
    if (!startDate) { handleActionError(new Error('empty start'), 'Enter a start date.'); return; }
    void savePatch({ startDate }, 'startDate');
  }, [canWrite, isCreate, scheduleEditable, startDate, contract, savePatch]);

  const commitEnd = useCallback(() => {
    if (!canWrite || isCreate) return;
    endEdited.current = false;
    const norm = endDate || null;
    if (norm === (contract?.endDate ?? null)) return;
    // Clearing the end date also disables auto-renew (which requires an end date).
    void savePatch(norm === null ? { endDate: null, autoRenew: false } : { endDate: norm }, 'endDate');
  }, [canWrite, isCreate, endDate, contract, savePatch]);

  const commitInterval = useCallback(() => {
    if (!canWrite || isCreate || !scheduleEditable) return;
    if (!intervalValid) return; // inline error already tells the operator why
    if (effectiveMonths === (contract?.intervalMonths ?? 0)) return;
    setIntervalMonths(effectiveMonths);
    void savePatch({ intervalMonths: effectiveMonths }, 'interval');
  }, [canWrite, isCreate, scheduleEditable, intervalValid, effectiveMonths, contract, savePatch]);

  const commitRenewalTerm = useCallback(() => {
    if (!canWrite || isCreate) return;
    renewalTermEdited.current = false;
    if (renewalTermMonths === persistedTerm) return;
    const n = renewalTermMonths === '' ? null : Number(renewalTermMonths);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 120)) {
      handleActionError(new Error('invalid term'), 'Enter a renewal term between 1 and 120 months.');
      return;
    }
    void savePatch({ renewalTermMonths: n }, 'renewalTerm');
  }, [canWrite, isCreate, renewalTermMonths, persistedTerm, savePatch]);

  const commitRenewalNotice = useCallback(() => {
    if (!canWrite || isCreate) return;
    renewalNoticeEdited.current = false;
    if (renewalNoticeDays === persistedNotice) return;
    const n = renewalNoticeDays === '' ? null : Number(renewalNoticeDays);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 365)) {
      handleActionError(new Error('invalid notice'), 'Enter advance notice between 0 and 365 days.');
      return;
    }
    void savePatch({ renewalNoticeDays: n }, 'renewalNotice');
  }, [canWrite, isCreate, renewalNoticeDays, persistedNotice, savePatch]);

  const commitNotes = useCallback(() => {
    if (!canWrite || isCreate) return;
    notesEdited.current = false;
    const next = notes.trim();
    if (next === (contract?.notes ?? '')) return;
    void savePatch({ notes: next || null }, 'notes');
  }, [canWrite, isCreate, notes, contract, savePatch]);

  const commitTerms = useCallback(() => {
    if (!canWrite || isCreate) return;
    termsEdited.current = false;
    const next = terms.trim();
    if (next === (contract?.terms ?? '')) return;
    void savePatch({ terms: next || null }, 'terms');
  }, [canWrite, isCreate, terms, contract, savePatch]);

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

  const removeLine = useCallback((lineId: string) =>
    runScoped(`remove-${lineId}`, async () => {
      if (!contract) return;
      await runAction({
        request: () => removeContractLine(contract.id, lineId),
        errorFallback: 'Could not remove the line.',
        successMessage: 'Line removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not remove the line.'),
  [runScoped, contract, refresh]);

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

  // Shared field chrome. `transition-shadow` pairs with fieldRing's box-shadow so
  // the amber→green cue animates without reflowing neighbours; `disabled:opacity-60`
  // renders the read-only (no contracts:write) and non-draft schedule states.
  const baseInput = 'h-10 rounded-md border bg-background px-3 text-sm text-foreground transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';
  const dateInput = `${baseInput} dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 hover:[&::-webkit-calendar-picker-indicator]:opacity-100`;
  const areaInput = 'rounded-md border bg-background px-3 py-2 text-sm text-foreground transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';
  const legendCls = 'mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

  return (
    <div className="space-y-6" data-testid="contract-editor">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── header form + lines ─────────────────────────────────────── */}
        <div className="space-y-6">
          <div className="space-y-6 rounded-lg border bg-card p-4 shadow-xs" data-testid="contract-header-form">
            {/* Existing contracts blur-autosave per field; a single polite live
                region announces the "Saved" that the amber→green ring shows. */}
            <SrSaved show={!isCreate && savedKeys.size > 0} testId="contract-field-saved" />

            {/* ── Schedule ─────────────────────────────────────────────── */}
            <fieldset className="min-w-0" data-testid="contract-schedule-group">
              <legend className={legendCls}>Schedule</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {isCreate ? (
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                    Organization
                    <select
                      value={orgId}
                      onChange={(e) => setOrgId(e.target.value)}
                      data-testid="contract-form-org"
                      className={baseInput}
                    >
                      <option value="">Select an organization…</option>
                      {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </label>
                ) : (
                  // Org is fixed at creation — the API never re-parents a contract,
                  // so it's a read-only display here.
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                    Organization
                    <span
                      data-testid="contract-form-org-readonly"
                      className="inline-flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm text-foreground"
                    >
                      {orgName}
                    </span>
                  </div>
                )}
                <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                  Name
                  <input
                    type="text" value={name} onChange={(e) => { setName(e.target.value); nameEdited.current = true; }} onBlur={commitName}
                    disabled={!canWrite}
                    placeholder="e.g. Managed Services — Acme Co"
                    data-testid="contract-form-name"
                    className={`${baseInput} ${fieldRing(nameDirty, isSaved('name'))}`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Billing timing
                  <select
                    value={billingTiming}
                    disabled={!canWrite || !scheduleEditable}
                    onChange={(e) => {
                      const v = e.target.value as ContractBillingTiming;
                      setBillingTiming(v);
                      if (!isCreate) void savePatch({ billingTiming: v }, 'timing');
                    }}
                    data-testid="contract-form-timing"
                    className={`${baseInput} ${fieldRing(false, isSaved('timing'))}`}
                  >
                    <option value="advance">In advance</option>
                    <option value="arrears">In arrears</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Billing cadence
                  <select
                    value={intervalCustom ? 'custom' : String(intervalMonths)}
                    disabled={!canWrite || !scheduleEditable}
                    onChange={(e) => {
                      if (e.target.value === 'custom') { setIntervalCustom(true); setCustomMonths(String(intervalMonths)); return; }
                      setIntervalCustom(false);
                      const n = Number(e.target.value);
                      setIntervalMonths(n);
                      if (!isCreate) void savePatch({ intervalMonths: n }, 'interval');
                    }}
                    data-testid="contract-form-interval"
                    className={`${baseInput} ${fieldRing(false, isSaved('interval'))}`}
                  >
                    {INTERVAL_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    <option value="custom">Custom…</option>
                  </select>
                </label>
                {intervalCustom && (
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Interval (months)
                    <input
                      type="number" min="1" max="60" value={customMonths}
                      onChange={(e) => setCustomMonths(e.target.value)}
                      onBlur={commitInterval}
                      disabled={!canWrite || !scheduleEditable}
                      data-testid="contract-form-interval-custom"
                      className={`${baseInput} ${fieldRing(intervalDirty, isSaved('interval'))}`}
                    />
                    {intervalError && (
                      <span className="text-destructive" data-testid="contract-interval-error">{intervalError}</span>
                    )}
                  </label>
                )}
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Start date
                  <input
                    type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); startEdited.current = true; }} onBlur={commitStart}
                    disabled={!canWrite || !scheduleEditable}
                    data-testid="contract-form-start"
                    className={`${dateInput} ${fieldRing(startDirty, isSaved('startDate'))}`}
                  />
                </label>
              </div>
            </fieldset>

            {/* ── Renewal ──────────────────────────────────────────────── */}
            <fieldset className="min-w-0" data-testid="contract-renewal-group">
              <legend className={legendCls}>Renewal</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  End date (optional)
                  <input
                    type="date" value={endDate}
                    onChange={(e) => { setEndDate(e.target.value); endEdited.current = true; if (!e.target.value) setAutoRenew(false); }}
                    onBlur={commitEnd}
                    disabled={!canWrite}
                    data-testid="contract-form-end"
                    className={`${dateInput} ${fieldRing(endDirty, isSaved('endDate'))}`}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox" checked={autoIssue} disabled={!canWrite}
                    onChange={(e) => { setAutoIssue(e.target.checked); if (!isCreate) void savePatch({ autoIssue: e.target.checked }, 'autoIssue'); }}
                    data-testid="contract-form-auto-issue"
                  />
                  Auto-issue generated invoices (otherwise they land as drafts)
                </label>
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm" data-testid="contract-auto-renew-toggle">
                    <input
                      type="checkbox" checked={autoRenew} disabled={!canWrite || !endDate}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setAutoRenew(checked);
                        if (!isCreate) void savePatch({
                          autoRenew: checked,
                          renewalTermMonths: checked ? (renewalTermMonths === '' ? null : Number(renewalTermMonths)) : null,
                          renewalNoticeDays: checked ? (renewalNoticeDays === '' ? null : Number(renewalNoticeDays)) : null,
                        }, 'autoRenew');
                      }}
                    />
                    <span>Auto-renew at end of term{!endDate ? ' (set an end date first)' : ''}</span>
                  </label>
                  {autoRenew && (
                    <div className="mt-2 grid grid-cols-2 gap-3" data-testid="contract-renewal-fields">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Renewal term (months)
                        <input
                          type="number" min={1} max={120} value={renewalTermMonths}
                          onChange={(e) => { setRenewalTermMonths(e.target.value); renewalTermEdited.current = true; }}
                          onBlur={commitRenewalTerm}
                          disabled={!canWrite}
                          data-testid="contract-renewal-term"
                          className={`${baseInput} ${fieldRing(renewalTermDirty, isSaved('renewalTerm'))}`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Advance notice (days)
                        <input
                          type="number" min={0} max={365} value={renewalNoticeDays}
                          onChange={(e) => { setRenewalNoticeDays(e.target.value); renewalNoticeEdited.current = true; }}
                          onBlur={commitRenewalNotice}
                          disabled={!canWrite}
                          data-testid="contract-renewal-notice-days"
                          className={`${baseInput} ${fieldRing(renewalNoticeDirty, isSaved('renewalNotice'))}`}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </fieldset>

            {/* ── Content ──────────────────────────────────────────────── */}
            <fieldset className="min-w-0" data-testid="contract-content-group">
              <legend className={legendCls}>Content</legend>
              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Notes (optional)
                  <textarea
                    value={notes} onChange={(e) => { setNotes(e.target.value); notesEdited.current = true; }} onBlur={commitNotes}
                    disabled={!canWrite} rows={2}
                    data-testid="contract-form-notes"
                    className={`${areaInput} ${fieldRing(notesDirty, isSaved('notes'))}`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Terms (optional, shown on the invoice)
                  <textarea
                    value={terms} onChange={(e) => { setTerms(e.target.value); termsEdited.current = true; }} onBlur={commitTerms}
                    disabled={!canWrite} rows={2}
                    data-testid="contract-form-terms"
                    placeholder="e.g. Net 30. Auto-renews unless cancelled 30 days prior."
                    className={`${areaInput} ${fieldRing(termsDirty, isSaved('terms'))}`}
                  />
                </label>
              </div>
            </fieldset>
          </div>

          {/* Lines (edit mode only — a contract needs an id before lines attach) */}
          {!isCreate && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-card shadow-xs">
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
                            {canWrite && (
                              <button
                                type="button" onClick={() => setPendingRemove(l)} disabled={isPending(`remove-${l.id}`)}
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
              <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="contract-add-line">
                {can('contracts', 'write') && (ecActive || pax8Active || (pax8IntegrationId && orgId)) && (
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                    <span className="text-xs text-muted-foreground">Add from an integration — it pre-fills a line.</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {pax8IntegrationId && orgId && (
                        <button
                          type="button"
                          onClick={() => setPax8Open(true)}
                          className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition hover:bg-muted"
                          data-testid="contract-link-pax8"
                        >
                          Link Pax8 subscription
                        </button>
                      )}
                      {pax8Active && (
                        <button
                          type="button"
                          onClick={() => setPax8CatalogOpen(true)}
                          className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition hover:bg-muted"
                          data-testid="contract-import-pax8-catalog"
                        >
                          Add from Pax8 catalog
                        </button>
                      )}
                      {ecActive && (
                        <button
                          type="button"
                          onClick={() => setDistributorOpen(true)}
                          className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition hover:bg-muted"
                          data-testid="contract-import-distributor"
                        >
                          Import from TD SYNNEX
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Line type
                    <select
                      value={lineType}
                      onChange={(e) => { setLineType(e.target.value as ContractLineType); setLineSiteId(''); }}
                      data-testid="contract-line-type"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Unit price
                    <input
                      type="number" min="0" step="0.01" value={linePrice}
                      onChange={(e) => setLinePrice(e.target.value)}
                      data-testid="contract-line-price"
                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  {lineType === 'manual' && (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Quantity
                      <input
                        type="number" min="0" step="0.01" value={lineQty}
                        onChange={(e) => setLineQty(e.target.value)}
                        data-testid="contract-line-qty"
                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                  )}
                  {lineType === 'per_device' && (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Site (optional — scopes the device count)
                      <select
                        value={lineSiteId} onChange={(e) => setLineSiteId(e.target.value)}
                        data-testid="contract-line-site"
                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
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
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="contract-estimate">
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
                {/* No whole-form Save button: existing contracts blur-autosave each
                    field. Status transitions (Activate) stay explicit. */}
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

      <CatalogDistributorDrawer
        open={distributorOpen}
        onClose={() => setDistributorOpen(false)}
        onImported={onDistributorImported}
      />

      <Pax8CatalogDrawer
        open={pax8CatalogOpen}
        onClose={() => setPax8CatalogOpen(false)}
        onImported={onDistributorImported}
      />

      {pax8IntegrationId && orgId && (
        <ContractPax8Drawer
          open={pax8Open}
          orgId={orgId}
          integrationId={pax8IntegrationId}
          onClose={() => setPax8Open(false)}
          onLinked={refresh}
        />
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          const line = pendingRemove;
          if (!line) return;
          // Leave the dialog open on failure (already toasted) so the user can
          // retry; only close once the line is actually gone.
          void (async () => {
            if (!(await removeLine(line.id))) return;
            setPendingRemove(null);
          })();
        }}
        isLoading={pendingRemove ? isPending(`remove-${pendingRemove.id}`) : false}
        title="Remove line"
        message={
          pendingRemove
            ? `This removes "${pendingRemove.description || 'this line'}" from the contract. This can't be undone.`
            : ''
        }
        confirmLabel="Remove line"
        confirmTestId="contract-line-remove-confirm"
      />
    </div>
  );
}
