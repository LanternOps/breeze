import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { usePermissions } from "../../lib/permissions";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import { useHashTab } from "@/lib/useHashState";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useStableT } from '@/lib/i18n/useStableT';
import {
  ACCOUNTING_PROVIDER_NAMES,
  accountingPath,
  type AccountingProviderId,
} from "../../lib/accountingProviders";

type MappingEntityType = "org" | "catalog_item";
type MappingConfidence =
  | "existing_link"
  | "exact_email"
  | "exact_sku"
  | "exact_name"
  | "none"
  | "ambiguous";
type MappingLinkStatus = "suggested" | "confirmed" | "create_new" | "unlinked";
/**
 * Mirrors `MappingSyncStatus` in
 * apps/api/src/services/accounting/accountingMappingService.ts.
 * `synced_with_tax_variance` is a Phase C invoice-push outcome that org/item
 * rows never produce themselves — but the API's union is one union, so a
 * missing arm here would have fallen through to the `pending` default and told
 * the operator a synced row was still waiting.
 */
type MappingSyncStatus =
  | "pending"
  | "synced"
  | "error"
  | "synced_with_tax_variance";
type MappingDecision = "confirmed" | "create_new" | "unlinked";

interface MappingProposal {
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  breezeDisplayName: string;
  remoteEntityType: "Customer" | "Item";
  proposedRemoteId: string | null;
  proposedRemoteName: string | null;
  confidence: MappingConfidence;
  linkStatus: MappingLinkStatus;
  syncStatus: MappingSyncStatus;
  lastError: string | null;
}

interface CuratedMapping {
  confidence: MappingConfidence;
  proposedRemoteName: string | null;
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  remoteEntityType: "Customer" | "Item";
  remoteEntityId: string | null;
  linkStatus: MappingLinkStatus;
  syncStatus: MappingSyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface RemoteIncomeAccount {
  id: string;
  displayName: string;
  accountType: string;
  /** Optional: QBO omits AccountSubType on some accounts, and the API passes
   *  the field through as-is (RemoteIncomeAccount in services/accounting/types.ts). */
  accountSubType?: string;
}

/** A provider record returned by GET /accounting/:provider/remote-candidates. */
interface RemoteCandidate {
  id: string;
  displayName: string;
  email?: string | null;
  sku?: string | null;
  currencyCode?: string | null;
  archived?: boolean;
}

/** The same normalisation the API's `normalizeMatchValue` applies (Xero W03):
 *  NFKC, trim, collapse internal whitespace runs, then lower-case with a fixed
 *  locale so the comparison never depends on the viewer's browser locale. */
const normalizeName = (s: string) =>
  s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

/**
 * Cleans a remote provider's record name into a search-box seed (Xero W03,
 * duplicate-name link flow). Strips angle brackets (Xero stores contact names
 * with `<`/`>` stripped), collapses whitespace runs, trims, then truncates to
 * at most 255 UTF-16 code units without splitting a surrogate pair — the
 * route's `q` param is `z.string().max(255)`.
 */
function seedSearchTerm(name: string): string {
  const cleaned = name.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= 255) return cleaned;
  let end = 255;
  // Don't split a surrogate pair: if the code unit just before the cut is a
  // high surrogate (0xD800–0xDBFF), back off one more so its low surrogate
  // partner stays attached.
  const before = cleaned.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return cleaned.slice(0, end);
}

/** Long enough that per-keystroke typing doesn't hammer a real QuickBooks API
 *  (every candidate search is an outbound QBO call), short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;
/** Settle poll after a decision lost the sync lock to the worker (#7386). */
const SETTLE_POLL_INTERVAL_MS = 1000;
const SETTLE_POLL_ATTEMPTS = 15;
/** A one-character query matches most of a company file — not worth a round trip. */
const MIN_SEARCH_LENGTH = 2;

// This workbench is nested two levels down (Integrations → Accounting →
// <provider>), and IntegrationsPage owns the single URL hash. Its tab ids are
// therefore namespaced with the provider's accounting sub-tab id they live
// under (`quickbooks-customers`, `xero-items`, …), which is the prefix
// IntegrationsPage.parseHash routes on to keep the page on Accounting/<provider>.
// Renaming these away from the `<provider>-` prefix would send the page back to
// its fallback tab on every tab click.
type WorkbenchTab = `${AccountingProviderId}-customers` | `${AccountingProviderId}-items`;

interface Props {
  provider: AccountingProviderId;
  onUnauthorized?: () => void;
  /** Current saved income account (from the parent's connection status), or
   *  null if none is set yet. Item creation/sync in QuickBooks requires one. */
  defaultIncomeAccountRef: string | null;
  /** Called after a successful income-account save so the parent's status
   *  (rendered elsewhere on the page) updates without a full page reload. */
  onSettingsChanged?: (settings: { defaultIncomeAccountRef: string | null }) => void;
  /** Where this provider's income account is edited (settings rule 1). "settings" = the
   *  connection's settings step owns it (providers with `features.settingsOptions`):
   *  the workbench shows no picker, never fetches /income-accounts, and points there. */
  incomeAccountHome?: "workbench" | "settings";
}

export default function AccountingMappingWorkbench({
  provider,
  onUnauthorized,
  defaultIncomeAccountRef,
  onSettingsChanged,
  incomeAccountHome = "workbench",
}: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const customersTab: WorkbenchTab = `${provider}-customers`;
  const itemsTab: WorkbenchTab = `${provider}-items`;
  const tabs = useMemo<readonly WorkbenchTab[]>(() => [customersTab, itemsTab], [customersTab, itemsTab]);

  /**
   * (PR review finding): every mutating control in this
   * workbench drives a route that now requires `accounting:manage` — Save
   * income account (PATCH /settings), Confirm/Create/Unlink (PUT /mappings)
   * and Sync now (POST /mappings/sync). Disable them without the grant so a
   * read-only caller sees an inert control instead of a 403. Loading proposals
   * and switching tabs are reads and stay operable. UX only — every route
   * re-checks server-side.
   */
  const canManageAccounting = usePermissions().can("accounting", "manage");
  const [tab, setTab] = useHashTab<WorkbenchTab>(tabs, customersTab);
  const entityType: MappingEntityType = tab === itemsTab ? "catalog_item" : "org";

  const [proposals, setProposals] = useState<MappingProposal[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-row settle-poll generation: a new action on the row (or leaving the
  // tab) bumps it, and any older poll for that row stops on its next tick.
  const settleEpochRef = useRef<Record<string, number>>({});
  const supersedeSettlePolls = (id?: string) => {
    const epochs = settleEpochRef.current;
    if (id) {
      epochs[id] = (epochs[id] ?? 0) + 1;
      return;
    }
    for (const key of Object.keys(epochs)) epochs[key] += 1;
  };
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [remoteSelection, setRemoteSelection] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string | null>>({});

  const [incomeAccounts, setIncomeAccounts] = useState<RemoteIncomeAccount[] | null>(null);
  const [incomeAccountRef, setIncomeAccountRef] = useState<string>(defaultIncomeAccountRef ?? "");
  const [savedIncomeAccountRef, setSavedIncomeAccountRef] = useState<string | null>(
    defaultIncomeAccountRef,
  );
  const [savingIncomeAccount, setSavingIncomeAccount] = useState(false);
  /** Keyed by breezeEntityId: the remote name from a rejected duplicate_name
   *  sync, seeded into that row's search box and cleared once the row moves. */
  const [searchSeed, setSearchSeed] = useState<Record<string, string>>({});

  // Keep the saved/pending income account in step with the prop (Xero W03):
  // when the settings step owns it, a save made there must re-enable "Create
  // new" here without a full reload. Previously read once at mount only.
  useEffect(() => {
    setSavedIncomeAccountRef(defaultIncomeAccountRef);
    setIncomeAccountRef(defaultIncomeAccountRef ?? "");
  }, [defaultIncomeAccountRef]);

  function switchTab(next: WorkbenchTab) {
    window.location.hash = next;
    setTab(next);
    supersedeSettlePolls();
    setProposals(null);
    setRowError({});
  }

  // Falls back to the proposal's own pre-filled suggested candidate the same
  // way the select's displayed value does (see `remoteValue` below) — a row
  // whose select is showing a suggested match without the operator touching
  // it must still be confirmable, not stuck disabled until they redundantly
  // re-pick the value already on screen.
  function remoteIdFor(id: string, p: MappingProposal): string {
    const selected = remoteSelection[id];
    if (selected !== undefined) return selected;
    return p.proposedRemoteId ?? "";
  }

  async function load() {
    setLoading(true);
    try {
      // Isolated from the mapping load below on purpose. The income-account
      // list only populates the selector; the mapping list is the screen's
      // whole purpose. Sharing one try/catch meant a QuickBooks Account-query
      // failure aborted the load before the mappings request was even issued,
      // leaving an empty workbench and a toast about income accounts. runAction
      // has already toasted by the time this catch runs, so it deliberately
      // swallows and continues — except a 401, which must still reach the
      // auth redirect via the outer handler.
      if (entityType === "catalog_item" && incomeAccountHome === "workbench" && incomeAccounts === null) {
        try {
          const accountsRes = await runAction<{ data: RemoteIncomeAccount[] }>({
            request: () => fetchWithAuth(accountingPath(provider, "/income-accounts")),
            errorFallback: t("accountingMapping.failedToLoadIncomeAccounts", { provider: providerName }),
            onUnauthorized,
          });
          setIncomeAccounts(accountsRes.data);
        } catch (err) {
          if (err instanceof ActionError && err.status === 401) throw err;
          if (!(err instanceof ActionError)) {
            handleActionError(err, t("accountingMapping.failedToLoadIncomeAccounts", { provider: providerName }));
          }
        }
      }
      const mappingsRes = await runAction<{ data: MappingProposal[] }>({
        request: () => fetchWithAuth(accountingPath(provider, `/mappings?entityType=${entityType}`)),
        errorFallback: t("accountingMapping.failedToLoadMappings", { provider: providerName }),
        onUnauthorized,
      });
      setProposals(mappingsRes.data);
      setRowError((prev) => {
        const next = { ...prev };
        for (const p of mappingsRes.data) next[p.breezeEntityId] = p.lastError;
        return next;
      });
    } catch (err) {
      handleActionError(err, t("accountingMapping.failedToLoadMappings", { provider: providerName }));
    } finally {
      setLoading(false);
    }
  }

  /**
   * Folds a curated mapping returned by the PUT/POST endpoints back into the
   * row it belongs to. The remote id, the confidence label and the row's own
   * pending selection all move together: the sync response is the only place
   * the newly created/linked QuickBooks id ever appears, so a row that ignored
   * it kept telling the operator "No match" and showed "—" in the combobox
   * until the whole list was reloaded (paper cut #2).
   */
  function applyMapping(mapping: CuratedMapping) {
    setProposals((prev) =>
      prev
        ? prev.map((p) =>
            p.breezeEntityId === mapping.breezeEntityId
              ? {
                  ...p,
                  linkStatus: mapping.linkStatus,
                  syncStatus: mapping.syncStatus,
                  proposedRemoteId: mapping.remoteEntityId,
                  // The PUT/sync response now carries the server's own
                  // `proposedRemoteName`/`confidence` (computed by
                  // `mappingResult`/`confidenceForMapping` in
                  // accountingMappingService.ts), which is authoritative —
                  // prefer it whenever present. The heuristics below only
                  // cover the case where a response omits them (defensive;
                  // also what older/partial mocks in this file's tests still
                  // exercise). Keep the one we already have when the id is
                  // unchanged. A row that had NO remote id before
                  // (p.proposedRemoteId was null) and now gets one is a fresh
                  // create — the record was just created under the Breeze
                  // display name (buildCustomerPayload / item payload), so
                  // that name IS the new record's name. Checking "no prior
                  // id" rather than p.linkStatus === "create_new" matters: a
                  // create_new row that already has an id (from an earlier
                  // create) can still be re-pointed at a *different*,
                  // already-existing remote record via manual search+confirm
                  // — that id change must NOT be relabeled with the Breeze
                  // name, since it names someone else's record. Otherwise
                  // drop the name so the picker labels the option with the id
                  // rather than another record's name.
                  proposedRemoteName:
                    mapping.proposedRemoteName != null
                      ? mapping.proposedRemoteName
                      : mapping.remoteEntityId && mapping.remoteEntityId === p.proposedRemoteId
                        ? p.proposedRemoteName
                        : mapping.remoteEntityId && !p.proposedRemoteId
                          ? p.breezeDisplayName
                          : null,
                  // A persisted remote id IS a link, not a guess — the same
                  // rule the API applies in confidenceForMapping().
                  confidence: mapping.confidence ?? (mapping.remoteEntityId ? "existing_link" : "none"),
                  lastError: mapping.lastError,
                }
              : p,
          )
        : prev,
    );
    // Drop the row's local pick so the select falls through to the server's
    // stored remote id (they agree after a successful decision, and after a
    // create/unlink the server's value is the truthful one).
    setRemoteSelection((prev) => {
      if (!(mapping.breezeEntityId in prev)) return prev;
      const next = { ...prev };
      delete next[mapping.breezeEntityId];
      return next;
    });
    setRowError((prev) => ({ ...prev, [mapping.breezeEntityId]: mapping.lastError }));
  }

  /**
   * Single handler for a rejected sync, shared by the manual button and the
   * post-decision auto-sync.
   *
   * It deliberately does NOT touch `syncStatus`. The API only persists
   * `syncStatus='error'` once a QuickBooks call actually failed; its pre-flight
   * refusals (currency_mismatch, income_account_required, item_price_required,
   * mapping_not_ready) leave the row `pending`. Painting a local "Sync failed"
   * badge over those made the row disagree with the server and silently flip
   * back to "Not synced" on the next load, with nothing left explaining why.
   * The reason is surfaced on the row instead (plus runAction's toast), and the
   * badge only reads "Sync failed" when a mapping really carries that status.
   */
  function handleSyncFailure(id: string, err: unknown) {
    if (err instanceof ActionError && err.status !== 401) {
      setRowError((prev) => ({ ...prev, [id]: err.message }));
      // Only a genuinely useful remoteName offers the "link it" flow — a
      // duplicate_name on the UPDATE path carries no `details` (its message
      // already tells the operator to rename), so there is nothing to seed.
      const remoteName = (err.body as { details?: { remoteName?: unknown } } | undefined)?.details?.remoteName;
      if (err.code === "duplicate_name" && typeof remoteName === "string" && remoteName) {
        setSearchSeed((prev) => ({ ...prev, [id]: seedSearchTerm(remoteName) }));
      }
    } else {
      handleActionError(err, t("accountingMapping.failedToSyncEntity", { provider: providerName }));
    }
  }

  /** The sync request itself, without row-busy/error bookkeeping, so the
   *  auto-sync that follows a decision reuses exactly the "Sync now" call. */
  async function requestSync(p: MappingProposal, opts: { joinInFlight?: boolean } = {}) {
    const res = await runAction<{ data: CuratedMapping }>({
      request: () =>
        fetchWithAuth(accountingPath(provider, "/mappings/sync"), {
          method: "POST",
          body: JSON.stringify({
            breezeEntityType: p.breezeEntityType,
            breezeEntityId: p.breezeEntityId,
          }),
        }),
      errorFallback: t("accountingMapping.failedToSyncEntity", { provider: providerName }),
      successMessage: t("accountingMapping.entitySynced", { provider: providerName }),
      // #7386: the PUT enqueues its own worker sync, so right after a decision
      // a sync_in_progress 409 means "already running", not "failed".
      ...(opts.joinInFlight
        ? { suppressErrorToast: (_status: number, code: string | undefined) => code === "sync_in_progress" }
        : {}),
      onUnauthorized,
    });
    applyMapping(res.data);
  }

  /**
   * The worker (enqueued by the PUT) holds the row's sync lock. Poll the row
   * until it leaves `pending` so it flips to Synced (or shows the worker's
   * error) without a manual reload. Bounded: a row still pending afterwards
   * stays pending and "Sync now" remains the retry.
   */
  async function settleRowAfterInFlightSync(p: MappingProposal) {
    supersedeSettlePolls(p.breezeEntityId);
    const epoch = settleEpochRef.current[p.breezeEntityId];
    const superseded = () => !mountedRef.current || settleEpochRef.current[p.breezeEntityId] !== epoch;
    for (let attempt = 0; attempt < SETTLE_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_INTERVAL_MS));
      if (superseded()) return;
      let res: { data: MappingProposal[] };
      try {
        res = await runAction<{ data: MappingProposal[] }>({
          request: () => fetchWithAuth(accountingPath(provider, `/mappings?entityType=${p.breezeEntityType}`)),
          errorFallback: t("accountingMapping.failedToLoadMappings", { provider: providerName }),
          // A transient poll failure must not paint an error on a row whose
          // sync is fine; the row stays as saved and the next poll retries.
          suppressErrorToast: () => true,
          onUnauthorized,
        });
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) throw err;
        continue;
      }
      if (superseded()) return;
      const fresh =res.data.find((row) => row.breezeEntityId === p.breezeEntityId);
      if (!fresh || fresh.syncStatus === "pending") continue;
      setProposals((prev) => prev?.map((row) => (row.breezeEntityId === fresh.breezeEntityId ? { ...row, ...fresh } : row)) ?? prev);
      setRowError((prev) => ({
        ...prev,
        [fresh.breezeEntityId]:
          fresh.lastError ??
          (fresh.syncStatus === "error" ? t("accountingMapping.failedToSyncEntity", { provider: providerName }) : null),
      }));
      if (fresh.syncStatus !== "error") {
        showToast({ message: t("accountingMapping.entitySynced", { provider: providerName }), type: "success" });
      }
      return;
    }
    // Still pending after the poll window: don't leave the click without an
    // outcome. The row is saved; the worker (or "Sync now") finishes it.
    if (superseded()) return;
    showToast({ message: t("accountingMapping.mappingSaved", { provider: providerName }), type: "success" });
  }

  async function decide(p: MappingProposal, decision: MappingDecision, remoteEntityId?: string) {
    const id = p.breezeEntityId;
    supersedeSettlePolls(id);
    setRowBusy((prev) => ({ ...prev, [id]: true }));
    setRowError((prev) => ({ ...prev, [id]: null }));
    setSearchSeed((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // The PUT only RECORDS the decision — nothing reaches QuickBooks until a
    // sync runs. Operators read the saved row as "done" and left ~10 confirmed
    // customers unsynced on prod (paper cut #1), so push it straight away and
    // keep "Sync now" as the manual retry. An unlink has nothing to push.
    const autoSyncs = decision !== "unlinked";
    try {
      const res = await runAction<{ data: CuratedMapping }>({
        request: () =>
          fetchWithAuth(accountingPath(provider, "/mappings"), {
            method: "PUT",
            body: JSON.stringify({
              breezeEntityType: p.breezeEntityType,
              breezeEntityId: id,
              decision,
              ...(remoteEntityId ? { remoteEntityId } : {}),
            }),
          }),
        errorFallback: t("accountingMapping.failedToSaveMapping", { provider: providerName }),
        // One click, one outcome. When the push follows, the sync's own toast
        // is the result the operator cares about; a "Mapping saved" toast in
        // front of it just doubles the noise.
        ...(autoSyncs ? {} : { successMessage: t("accountingMapping.mappingSaved", { provider: providerName }) }),
        onUnauthorized,
      });
      applyMapping(res.data);
      if (autoSyncs) {
        // The saved row, not the button that produced it, decides whether the
        // push is allowed — the same gate "Sync now" applies.
        if (syncGatedForMapping(res.data)) {
          showToast({ message: t("accountingMapping.mappingSaved", { provider: providerName }), type: "success" });
        } else {
          try {
            await requestSync(p, { joinInFlight: true });
          } catch (err) {
            if (err instanceof ActionError && err.code === "sync_in_progress") {
              try {
                await settleRowAfterInFlightSync(p);
              } catch (pollErr) {
                handleSyncFailure(id, pollErr);
              }
            } else {
              handleSyncFailure(id, err);
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof ActionError && err.status !== 401) {
        setRowError((prev) => ({ ...prev, [id]: err.message }));
      } else {
        handleActionError(err, t("accountingMapping.failedToSaveMapping", { provider: providerName }));
      }
    } finally {
      setRowBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function sync(p: MappingProposal) {
    const id = p.breezeEntityId;
    supersedeSettlePolls(id);
    setRowBusy((prev) => ({ ...prev, [id]: true }));
    setRowError((prev) => ({ ...prev, [id]: null }));
    setSearchSeed((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await requestSync(p);
    } catch (err) {
      handleSyncFailure(id, err);
    } finally {
      setRowBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function saveIncomeAccount() {
    setSavingIncomeAccount(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(accountingPath(provider, "/settings"), {
            method: "PATCH",
            body: JSON.stringify({ defaultIncomeAccountRef: incomeAccountRef || null }),
          }),
        errorFallback: t("accountingMapping.failedToSaveIncomeAccount", { provider: providerName }),
        successMessage: t("accountingMapping.incomeAccountSaved", { provider: providerName }),
        onUnauthorized,
      });
      const saved = incomeAccountRef || null;
      setSavedIncomeAccountRef(saved);
      onSettingsChanged?.({ defaultIncomeAccountRef: saved });
    } catch (err) {
      handleActionError(err, t("accountingMapping.failedToSaveIncomeAccount", { provider: providerName }));
    } finally {
      setSavingIncomeAccount(false);
    }
  }

  // Only a CREATE against QuickBooks requires a default income account (the
  // API's income_account_required guard is `isCreate && !defaultIncomeAccountRef`,
  // where isCreate means the mapping has no remoteEntityId yet — see
  // syncMappedEntity in accountingMappingService.ts). The "Create new" button
  // always issues a create decision, so it's gated for every item row.
  // "Sync now" on an already-confirmed/linked row pushes an UPDATE, which
  // never touches the income account, so only a `create_new` row's sync
  // (which may still be an unpersisted create) is gated.
  const createGated = entityType === "catalog_item" && !savedIncomeAccountRef;
  /** One gate, applied to whichever record carries the row's link status —
   *  the loaded proposal for the button, the PUT response for the auto-sync. */
  function syncGatedForLinkStatus(linkStatus: MappingLinkStatus): boolean {
    return entityType === "catalog_item" && linkStatus === "create_new" && !savedIncomeAccountRef;
  }
  function syncGatedFor(p: MappingProposal): boolean {
    return syncGatedForLinkStatus(p.linkStatus);
  }
  function syncGatedForMapping(mapping: CuratedMapping): boolean {
    return syncGatedForLinkStatus(mapping.linkStatus);
  }

  return (
    <div data-testid={`${provider}-mapping-workbench`} className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("accountingMapping.mappingTitle", { provider: providerName })}</h2>
        <button
          type="button"
          data-testid={`${provider}-mapping-load`}
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {proposals ? t("accountingMapping.refreshMappings", { provider: providerName }) : t("accountingMapping.loadMappings", { provider: providerName })}
        </button>
      </div>

      <div role="tablist" className="inline-flex overflow-hidden rounded-md border">
        {tabs.map((id) => {
          const active = tab === id;
          const label = id === customersTab ? t("accountingMapping.customers", { provider: providerName }) : t("accountingMapping.items", { provider: providerName });
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`${provider}-mapping-tab-${id === customersTab ? "customers" : "items"}`}
              onClick={() => switchTab(id)}
              className={`px-3 py-1.5 text-sm transition ${
                active ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {entityType === "catalog_item" && incomeAccountHome === "workbench" && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${provider}-income-account-select`} className="font-medium">
              {t("accountingMapping.incomeAccount", { provider: providerName })}
            </label>
            <select
              id={`${provider}-income-account-select`}
              data-testid={`${provider}-income-account-select`}
              value={incomeAccountRef}
              onChange={(e) => setIncomeAccountRef(e.target.value)}
              className="rounded-md border px-2 py-1"
            >
              <option value="">—</option>
              {/* Transient-orphan guard: the saved/selected ref can be set
                  before `incomeAccounts` has loaded (e.g. on mount from
                  `defaultIncomeAccountRef`), which would otherwise leave the
                  controlled `value` pointing at an <option> that doesn't
                  exist yet. Render a placeholder carrying that id until the
                  real list loads and (usually) supersedes it. */}
              {incomeAccountRef && !(incomeAccounts ?? []).some((a) => a.id === incomeAccountRef) && (
                <option value={incomeAccountRef}>{incomeAccountRef}</option>
              )}
              {(incomeAccounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid={`${provider}-income-account-save`}
              onClick={() => void saveIncomeAccount()}
              disabled={savingIncomeAccount || !incomeAccountRef || !canManageAccounting}
              className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t("accountingMapping.saveIncomeAccount", { provider: providerName })}
            </button>
          </div>
          {!savedIncomeAccountRef && (
            <p
              data-testid={`${provider}-income-account-required`}
              className="mt-2 text-amber-700"
            >
              {t("accountingMapping.incomeAccountRequired", { provider: providerName })}
            </p>
          )}
        </div>
      )}

      {entityType === "catalog_item" && incomeAccountHome === "settings" && !savedIncomeAccountRef && (
        <p
          data-testid={`${provider}-income-account-in-settings`}
          className="rounded-md border bg-muted/30 p-3 text-sm"
        >
          {t("accountingMapping.incomeAccountInSettings", { provider: providerName })}
        </p>
      )}

      {proposals && proposals.length === 0 && (
        <p data-testid={`${provider}-mapping-empty`} className="text-sm text-muted-foreground">
          {t("accountingMapping.noProposals", { provider: providerName })}
        </p>
      )}

      {proposals && proposals.length > 0 && (
        <table className="w-full text-sm" data-testid={`${provider}-mapping-table`}>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>{t("common:labels.name")}</th>
              <th>{t("accountingMapping.suggestedMatch", { provider: providerName })}</th>
              <th />
              <th>{t("accountingMapping.incomeAccount", { provider: providerName })}</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => {
              const id = p.breezeEntityId;
              const busy = !!rowBusy[id];
              // `existing_link` is a recorded link, not a guess — labelling it
              // "Suggested match" told the operator Breeze had proposed the
              // mapping they themselves confirmed. The API only reports it for
              // a persisted row that actually carries a remote id
              // (confidenceForMapping, accountingMappingService.ts).
              const confidenceLabel =
                p.confidence === "ambiguous"
                  ? t("accountingMapping.ambiguousMatch", { provider: providerName })
                  : p.confidence === "none"
                    ? t("accountingMapping.noMatch", { provider: providerName })
                    : p.confidence === "existing_link"
                      ? t("accountingMapping.linkedMatch", { provider: providerName })
                      : t("accountingMapping.suggestedMatch", { provider: providerName });
              // "Pending" read as "Breeze is working on it"; it actually means
              // the decision never left Breeze. Name the three states after
              // where the record IS, and explain the unsynced one in a tooltip.
              const statusLabel =
                p.syncStatus === "synced"
                  ? t("accountingMapping.inProvider", { provider: providerName })
                  : p.syncStatus === "synced_with_tax_variance"
                    ? t("accountingMapping.syncedWithTaxVariance", { provider: providerName })
                    : p.syncStatus === "error"
                      ? t("accountingMapping.syncFailed", { provider: providerName })
                      : t("accountingMapping.notSynced", { provider: providerName });
              // The hint explains a decision the operator made; a row they
              // never touched is unsynced simply because nothing was decided.
              const statusTitle =
                p.syncStatus === "pending" &&
                (p.linkStatus === "confirmed" || p.linkStatus === "create_new")
                  ? t("accountingMapping.notSyncedHint", { provider: providerName })
                  : undefined;
              const remoteValue = remoteSelection[id] ?? (p.proposedRemoteId ? p.proposedRemoteId : "");
              const syncGated = syncGatedFor(p);
              const error = rowError[id];

              return (
                <tr key={id} data-testid={`${provider}-mapping-row-${id}`} className="border-t align-top">
                  <td className="py-2 pr-2">
                    <div className="font-medium">{p.breezeDisplayName}</div>
                    <div
                      data-testid={`${provider}-mapping-status-${id}`}
                      title={statusTitle}
                      className={
                        p.syncStatus === "error"
                          ? "text-xs text-red-700"
                          : p.syncStatus === "pending"
                            ? "text-xs text-amber-700"
                            : "text-xs text-muted-foreground"
                      }
                    >
                      {statusLabel}
                    </div>
                    <div data-testid={`${provider}-mapping-linkstatus-${id}`} className="text-xs text-muted-foreground">
                      {p.linkStatus === "confirmed"
                        ? t("accountingMapping.confirmed", { provider: providerName })
                        : p.linkStatus === "create_new"
                          ? t("accountingMapping.createNew", { provider: providerName })
                          : p.linkStatus === "unlinked"
                            ? t("accountingMapping.unlink", { provider: providerName })
                            : null}
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <span data-testid={`${provider}-mapping-confidence-${id}`}>{confidenceLabel}</span>
                  </td>
                  <td className="py-2 pr-2">
                    <RemoteCandidatePicker
                      provider={provider}
                      rowId={id}
                      entityType={entityType}
                      disabled={busy}
                      value={remoteValue}
                      proposed={
                        p.proposedRemoteId
                          ? { id: p.proposedRemoteId, displayName: p.proposedRemoteName ?? p.proposedRemoteId }
                          : null
                      }
                      onSelect={(remoteId) =>
                        setRemoteSelection((prev) => ({ ...prev, [id]: remoteId }))
                      }
                      onUnauthorized={onUnauthorized}
                      seedTerm={searchSeed[id]}
                    />
                  </td>
                  <td className="space-x-1 py-2">
                    <button
                      type="button"
                      data-testid={`${provider}-mapping-confirm-${id}`}
                      disabled={busy || !remoteIdFor(id, p) || !canManageAccounting}
                      onClick={() => void decide(p, "confirmed", remoteIdFor(id, p))}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("accountingMapping.confirmMatch", { provider: providerName })}
                    </button>
                    <button
                      type="button"
                      data-testid={`${provider}-mapping-create-${id}`}
                      disabled={busy || createGated || !canManageAccounting}
                      onClick={() => void decide(p, "create_new")}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("accountingMapping.createNew", { provider: providerName })}
                    </button>
                    <button
                      type="button"
                      data-testid={`${provider}-mapping-unlink-${id}`}
                      disabled={busy || p.linkStatus === "unlinked" || !canManageAccounting}
                      onClick={() => void decide(p, "unlinked")}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("accountingMapping.unlink", { provider: providerName })}
                    </button>
                    <button
                      type="button"
                      data-testid={`${provider}-mapping-sync-${id}`}
                      disabled={busy || syncGated || !canManageAccounting}
                      onClick={() => void sync(p)}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("accountingMapping.syncNow", { provider: providerName })}
                    </button>
                    {error && (
                      <p
                        data-testid={`${provider}-mapping-error-${id}`}
                        className="mt-1 text-xs text-red-700"
                      >
                        {error}
                      </p>
                    )}
                    {searchSeed[id] && (
                      <p
                        data-testid={`${provider}-mapping-duplicate-hint-${id}`}
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        {t("accountingMapping.duplicateNameHint", { provider: providerName })}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface PickerProps {
  provider: AccountingProviderId;
  rowId: string;
  entityType: MappingEntityType;
  disabled: boolean;
  /** The remote id currently chosen for this row (may be the API's suggestion). */
  value: string;
  /** The API's own suggested match, kept selectable even before any search. */
  proposed: { id: string; displayName: string } | null;
  onSelect: (remoteId: string) => void;
  onUnauthorized?: () => void;
  /** A remote name to seed the search box with (Xero W03 duplicate-name link
   *  flow) — normalised via `seedSearchTerm` by the caller. Runs the search
   *  once and, on a single exact normalised-name match, preselects it. */
  seedTerm?: string;
}

/**
 * Live QuickBooks lookup for one mapping row, replacing the old "enter the
 * remote ID by hand" escape hatch (Phase B follow-up #4). Own component so the
 * debounce timer and result list are per-row state rather than four parallel
 * `Record<string, …>` maps in the parent — and so an unmounted row's in-flight
 * search can't write back.
 */
function RemoteCandidatePicker({
  provider,
  rowId,
  entityType,
  disabled,
  value,
  proposed,
  onSelect,
  onUnauthorized,
  seedTerm,
}: PickerProps) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [term, setTerm] = useState("");
  const [candidates, setCandidates] = useState<RemoteCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);

  // The parent passes a fresh `onSelect` arrow every render, and a preselect
  // itself updates parent state — depending on either from the search effect
  // would re-run the search on every re-render (a request loop for a seeded
  // search, and a refetch on every ordinary pick for every provider). Read
  // both through a ref instead; only `seedTerm` drives the effect.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const valueRef = useRef(value);
  valueRef.current = value;
  const appliedSeed = useRef<string | null>(null);

  useEffect(() => {
    if (seedTerm) setTerm(seedTerm);
  }, [seedTerm]);

  useEffect(() => {
    const q = term.trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      setCandidates(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await runAction<{ data: RemoteCandidate[] }>({
            request: () =>
              fetchWithAuth(
                accountingPath(provider, `/remote-candidates?entityType=${entityType}&q=${encodeURIComponent(q)}`),
              ),
            errorFallback: stableT("accountingMapping.failedToSearchCandidates", { provider: providerName }),
            onUnauthorized,
          });
          if (!cancelled) setCandidates(res.data);
          // Seeded exact-match preselect (Xero W03 duplicate-name link flow):
          // fires at most once per seed, only for the search that seed itself
          // triggered (q === the seed we sent), and only when exactly one
          // candidate's displayName normalises to the same value.
          if (!cancelled && seedTerm && q === seedTerm.trim() && appliedSeed.current !== seedTerm) {
            appliedSeed.current = seedTerm;
            const wanted = normalizeName(seedTerm);
            const exact = res.data.filter((c) => normalizeName(c.displayName) === wanted);
            if (exact.length === 1 && exact[0]!.id !== valueRef.current) onSelectRef.current(exact[0]!.id);
          }
        } catch (err) {
          // runAction has already toasted anything but a 401; keep the row
          // usable (the suggested option is still selectable) instead of
          // wedging it behind a permanent spinner.
          if (!cancelled) setCandidates([]);
          handleActionError(err, stableT("accountingMapping.failedToSearchCandidates", { provider: providerName }));
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // `onSelect` and `value` are deliberately absent — read via ref above.
  }, [term, entityType, onUnauthorized, stableT, provider, providerName, seedTerm]);

  // Suggested match first, then search hits, de-duplicated by remote id. The
  // currently selected id is always present as an option even when it is in
  // neither list (a stale suggestion, or a search that has since been cleared),
  // so the controlled <select> never points at an option that doesn't exist.
  const options: { id: string; label: string; archived: boolean }[] = [];
  const seen = new Set<string>();
  // Live candidates before archived ones (Xero W03: archived remote records
  // are still valid link targets, but shouldn't crowd out active matches).
  const ordered = [...(candidates ?? [])].sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
  for (const candidate of [
    ...(proposed ? [{ id: proposed.id, displayName: proposed.displayName }] : []),
    ...ordered,
  ]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const suffix = "sku" in candidate && candidate.sku ? ` (${candidate.sku})`
      : "email" in candidate && candidate.email ? ` (${candidate.email})` : "";
    const isArchived = "archived" in candidate && !!candidate.archived;
    const archivedSuffix = isArchived ? ` · ${t("accountingMapping.archived")}` : "";
    options.push({ id: candidate.id, label: `${candidate.displayName}${suffix}${archivedSuffix}`, archived: isArchived });
  }
  if (value && !seen.has(value)) options.unshift({ id: value, label: value, archived: false });

  return (
    <div className="space-y-1">
      <input
        type="search"
        data-testid={`${provider}-mapping-search-${rowId}`}
        value={term}
        disabled={disabled}
        onChange={(e) => setTerm(e.target.value)}
        placeholder={t("accountingMapping.searchPlaceholder", { provider: providerName })}
        aria-label={t("accountingMapping.searchPlaceholder", { provider: providerName })}
        className="w-48 rounded-md border px-2 py-1"
      />
      <select
        data-testid={`${provider}-mapping-remote-${rowId}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
        className="block w-48 rounded-md border px-2 py-1"
      >
        <option value="">—</option>
        {options.map((option) => (
          <option
            key={option.id}
            value={option.id}
            data-testid={option.archived ? `${provider}-candidate-archived-${option.id}` : undefined}
          >
            {option.label}
          </option>
        ))}
      </select>
      {searching && (
        <p
          data-testid={`${provider}-mapping-searching-${rowId}`}
          className="text-xs text-muted-foreground"
        >
          {t("accountingMapping.searching", { provider: providerName })}
        </p>
      )}
      {!searching && candidates?.length === 0 && (
        <p
          data-testid={`${provider}-mapping-no-candidates-${rowId}`}
          className="text-xs text-muted-foreground"
        >
          {t("accountingMapping.noCandidates", { provider: providerName })}
        </p>
      )}
    </div>
  );
}
