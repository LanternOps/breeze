import { useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError, ActionError } from "../../lib/runAction";
import { useHashTab } from "@/lib/useHashState";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type MappingEntityType = "org" | "catalog_item";
type MappingConfidence =
  | "existing_link"
  | "exact_email"
  | "exact_sku"
  | "exact_name"
  | "none"
  | "ambiguous";
type MappingLinkStatus = "suggested" | "confirmed" | "create_new" | "unlinked";
type MappingSyncStatus = "pending" | "synced" | "error";
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

const MANUAL_REMOTE_OPTION = "__manual__";
const TABS = ["quickbooks-customers", "quickbooks-items"] as const;
type WorkbenchTab = (typeof TABS)[number];

interface Props {
  onUnauthorized?: () => void;
  /** Current saved income account (from the parent's connection status), or
   *  null if none is set yet. Item creation/sync in QuickBooks requires one. */
  defaultIncomeAccountRef: string | null;
  /** Called after a successful income-account save so the parent's status
   *  (rendered elsewhere on the page) updates without a full page reload. */
  onSettingsChanged?: (settings: { defaultIncomeAccountRef: string | null }) => void;
}

export default function QuickbooksMappingWorkbench({
  onUnauthorized,
  defaultIncomeAccountRef,
  onSettingsChanged,
}: Props) {
  const { t } = useTranslation("integrations");
  const [tab, setTab] = useHashTab<WorkbenchTab>(TABS, "quickbooks-customers");
  const entityType: MappingEntityType = tab === "quickbooks-items" ? "catalog_item" : "org";

  const [proposals, setProposals] = useState<MappingProposal[] | null>(null);
  const [loading, setLoading] = useState(false);

  const [remoteSelection, setRemoteSelection] = useState<Record<string, string>>({});
  const [manualRemoteId, setManualRemoteId] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string | null>>({});

  const [incomeAccounts, setIncomeAccounts] = useState<RemoteIncomeAccount[] | null>(null);
  const [incomeAccountRef, setIncomeAccountRef] = useState<string>(defaultIncomeAccountRef ?? "");
  const [savedIncomeAccountRef, setSavedIncomeAccountRef] = useState<string | null>(
    defaultIncomeAccountRef,
  );
  const [savingIncomeAccount, setSavingIncomeAccount] = useState(false);

  function switchTab(next: WorkbenchTab) {
    window.location.hash = next;
    setTab(next);
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
    if (selected === MANUAL_REMOTE_OPTION) return (manualRemoteId[id] ?? "").trim();
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
      if (entityType === "catalog_item" && incomeAccounts === null) {
        try {
          const accountsRes = await runAction<{ data: RemoteIncomeAccount[] }>({
            request: () => fetchWithAuth("/accounting/quickbooks/income-accounts"),
            errorFallback: t("quickbooksMapping.failedToLoadIncomeAccounts"),
            onUnauthorized,
          });
          setIncomeAccounts(accountsRes.data);
        } catch (err) {
          if (err instanceof ActionError && err.status === 401) throw err;
          if (!(err instanceof ActionError)) {
            handleActionError(err, t("quickbooksMapping.failedToLoadIncomeAccounts"));
          }
        }
      }
      const mappingsRes = await runAction<{ data: MappingProposal[] }>({
        request: () => fetchWithAuth(`/accounting/quickbooks/mappings?entityType=${entityType}`),
        errorFallback: t("quickbooksMapping.failedToLoadMappings"),
        onUnauthorized,
      });
      setProposals(mappingsRes.data);
      setRowError((prev) => {
        const next = { ...prev };
        for (const p of mappingsRes.data) next[p.breezeEntityId] = p.lastError;
        return next;
      });
    } catch (err) {
      handleActionError(err, t("quickbooksMapping.failedToLoadMappings"));
    } finally {
      setLoading(false);
    }
  }

  function applyMapping(mapping: CuratedMapping) {
    setProposals((prev) =>
      prev
        ? prev.map((p) =>
            p.breezeEntityId === mapping.breezeEntityId
              ? {
                  ...p,
                  linkStatus: mapping.linkStatus,
                  syncStatus: mapping.syncStatus,
                  proposedRemoteId: mapping.remoteEntityId ?? p.proposedRemoteId,
                  lastError: mapping.lastError,
                }
              : p,
          )
        : prev,
    );
    setRowError((prev) => ({ ...prev, [mapping.breezeEntityId]: mapping.lastError }));
  }

  async function decide(p: MappingProposal, decision: MappingDecision, remoteEntityId?: string) {
    const id = p.breezeEntityId;
    setRowBusy((prev) => ({ ...prev, [id]: true }));
    setRowError((prev) => ({ ...prev, [id]: null }));
    try {
      const res = await runAction<{ data: CuratedMapping }>({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/mappings", {
            method: "PUT",
            body: JSON.stringify({
              breezeEntityType: p.breezeEntityType,
              breezeEntityId: id,
              decision,
              ...(remoteEntityId ? { remoteEntityId } : {}),
            }),
          }),
        errorFallback: t("quickbooksMapping.failedToSaveMapping"),
        successMessage: t("quickbooksMapping.mappingSaved"),
        onUnauthorized,
      });
      applyMapping(res.data);
    } catch (err) {
      if (err instanceof ActionError && err.status !== 401) {
        setRowError((prev) => ({ ...prev, [id]: err.message }));
      } else {
        handleActionError(err, t("quickbooksMapping.failedToSaveMapping"));
      }
    } finally {
      setRowBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function sync(p: MappingProposal) {
    const id = p.breezeEntityId;
    setRowBusy((prev) => ({ ...prev, [id]: true }));
    setRowError((prev) => ({ ...prev, [id]: null }));
    try {
      const res = await runAction<{ data: CuratedMapping }>({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/mappings/sync", {
            method: "POST",
            body: JSON.stringify({ breezeEntityType: p.breezeEntityType, breezeEntityId: id }),
          }),
        errorFallback: t("quickbooksMapping.failedToSyncEntity"),
        successMessage: t("quickbooksMapping.entitySynced"),
        onUnauthorized,
      });
      applyMapping(res.data);
    } catch (err) {
      if (err instanceof ActionError && err.status !== 401) {
        setRowError((prev) => ({ ...prev, [id]: err.message }));
      } else {
        handleActionError(err, t("quickbooksMapping.failedToSyncEntity"));
      }
    } finally {
      setRowBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function saveIncomeAccount() {
    setSavingIncomeAccount(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/settings", {
            method: "PATCH",
            body: JSON.stringify({ defaultIncomeAccountRef: incomeAccountRef || null }),
          }),
        errorFallback: t("quickbooksMapping.failedToSaveIncomeAccount"),
        successMessage: t("quickbooksMapping.incomeAccountSaved"),
        onUnauthorized,
      });
      const saved = incomeAccountRef || null;
      setSavedIncomeAccountRef(saved);
      onSettingsChanged?.({ defaultIncomeAccountRef: saved });
    } catch (err) {
      handleActionError(err, t("quickbooksMapping.failedToSaveIncomeAccount"));
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
  function syncGatedFor(p: MappingProposal): boolean {
    return entityType === "catalog_item" && p.linkStatus === "create_new" && !savedIncomeAccountRef;
  }

  return (
    <div data-testid="quickbooks-mapping-workbench" className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("quickbooksMapping.mappingTitle")}</h2>
        <button
          type="button"
          data-testid="quickbooks-mapping-load"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {proposals ? t("quickbooksMapping.refreshMappings") : t("quickbooksMapping.loadMappings")}
        </button>
      </div>

      <div role="tablist" className="inline-flex overflow-hidden rounded-md border">
        {TABS.map((id) => {
          const active = tab === id;
          const label = id === "quickbooks-customers" ? t("quickbooksMapping.customers") : t("quickbooksMapping.items");
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`quickbooks-mapping-tab-${id === "quickbooks-customers" ? "customers" : "items"}`}
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

      {entityType === "catalog_item" && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="quickbooks-income-account-select" className="font-medium">
              {t("quickbooksMapping.incomeAccount")}
            </label>
            <select
              id="quickbooks-income-account-select"
              data-testid="quickbooks-income-account-select"
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
              data-testid="quickbooks-income-account-save"
              onClick={() => void saveIncomeAccount()}
              disabled={savingIncomeAccount || !incomeAccountRef}
              className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t("quickbooksMapping.saveIncomeAccount")}
            </button>
          </div>
          {!savedIncomeAccountRef && (
            <p
              data-testid="quickbooks-income-account-required"
              className="mt-2 text-amber-700"
            >
              {t("quickbooksMapping.incomeAccountRequired")}
            </p>
          )}
        </div>
      )}

      {proposals && proposals.length === 0 && (
        <p data-testid="quickbooks-mapping-empty" className="text-sm text-muted-foreground">
          {t("quickbooksMapping.noProposals")}
        </p>
      )}

      {proposals && proposals.length > 0 && (
        <table className="w-full text-sm" data-testid="quickbooks-mapping-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>{t("common:labels.name")}</th>
              <th>{t("quickbooksMapping.suggestedMatch")}</th>
              <th />
              <th>{t("quickbooksMapping.incomeAccount")}</th>
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
                  ? t("quickbooksMapping.ambiguousMatch")
                  : p.confidence === "none"
                    ? t("quickbooksMapping.noMatch")
                    : p.confidence === "existing_link"
                      ? t("quickbooksMapping.linkedMatch")
                      : t("quickbooksMapping.suggestedMatch");
              const statusLabel =
                p.syncStatus === "synced"
                  ? t("quickbooksMapping.synced")
                  : p.syncStatus === "error"
                    ? t("quickbooksMapping.syncError")
                    : t("quickbooksMapping.pending");
              const remoteValue = remoteSelection[id] ?? (p.proposedRemoteId ? p.proposedRemoteId : "");
              const isManual = remoteValue === MANUAL_REMOTE_OPTION;
              const syncGated = syncGatedFor(p);
              const error = rowError[id];

              return (
                <tr key={id} data-testid={`quickbooks-mapping-row-${id}`} className="border-t align-top">
                  <td className="py-2 pr-2">
                    <div className="font-medium">{p.breezeDisplayName}</div>
                    <div
                      data-testid={`quickbooks-mapping-status-${id}`}
                      className="text-xs text-muted-foreground"
                    >
                      {statusLabel}
                    </div>
                    <div data-testid={`quickbooks-mapping-linkstatus-${id}`} className="text-xs text-muted-foreground">
                      {p.linkStatus === "confirmed"
                        ? t("quickbooksMapping.confirmed")
                        : p.linkStatus === "create_new"
                          ? t("quickbooksMapping.createNew")
                          : p.linkStatus === "unlinked"
                            ? t("quickbooksMapping.unlink")
                            : null}
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <span data-testid={`quickbooks-mapping-confidence-${id}`}>{confidenceLabel}</span>
                  </td>
                  <td className="py-2 pr-2">
                    <select
                      data-testid={`quickbooks-mapping-remote-${id}`}
                      value={remoteValue}
                      disabled={busy}
                      onChange={(e) =>
                        setRemoteSelection((prev) => ({ ...prev, [id]: e.target.value }))
                      }
                      className="rounded-md border px-2 py-1"
                    >
                      <option value="">—</option>
                      {p.proposedRemoteId && (
                        <option value={p.proposedRemoteId}>
                          {p.proposedRemoteName ?? p.proposedRemoteId}
                        </option>
                      )}
                      <option value={MANUAL_REMOTE_OPTION}>{t("quickbooksMapping.manualEntry")}</option>
                    </select>
                    {isManual && (
                      <input
                        type="text"
                        data-testid={`quickbooks-mapping-remote-manual-${id}`}
                        value={manualRemoteId[id] ?? ""}
                        onChange={(e) =>
                          setManualRemoteId((prev) => ({ ...prev, [id]: e.target.value }))
                        }
                        placeholder={t("quickbooksMapping.manualEntry")}
                        className="ml-2 rounded-md border px-2 py-1"
                      />
                    )}
                  </td>
                  <td className="space-x-1 py-2">
                    <button
                      type="button"
                      data-testid={`quickbooks-mapping-confirm-${id}`}
                      disabled={busy || !remoteIdFor(id, p)}
                      onClick={() => void decide(p, "confirmed", remoteIdFor(id, p))}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("quickbooksMapping.confirmMatch")}
                    </button>
                    <button
                      type="button"
                      data-testid={`quickbooks-mapping-create-${id}`}
                      disabled={busy || createGated}
                      onClick={() => void decide(p, "create_new")}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("quickbooksMapping.createNew")}
                    </button>
                    <button
                      type="button"
                      data-testid={`quickbooks-mapping-unlink-${id}`}
                      disabled={busy || p.linkStatus === "unlinked"}
                      onClick={() => void decide(p, "unlinked")}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("quickbooksMapping.unlink")}
                    </button>
                    <button
                      type="button"
                      data-testid={`quickbooks-mapping-sync-${id}`}
                      disabled={busy || syncGated}
                      onClick={() => void sync(p)}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      {t("quickbooksMapping.syncNow")}
                    </button>
                    {error && (
                      <p
                        data-testid={`quickbooks-mapping-error-${id}`}
                        className="mt-1 text-xs text-red-700"
                      >
                        {error}
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
