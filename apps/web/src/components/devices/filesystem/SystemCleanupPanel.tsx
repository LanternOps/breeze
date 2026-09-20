import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { ActionError, runAction } from "../../../lib/runAction";
import { fetchWithAuth } from "../../../stores/auth";
import { formatBytes } from "../../../lib/utils";
import "../../../lib/i18n";

type RiskFlag =
  | "long_running"
  | "may_require_reboot"
  | "may_require_reboot_free_state"
  | "removes_driver_rollback"
  | "removes_packages"
  | "removes_os_rollback"
  | "removes_recovery_points";

type SubAction = { id: string; label: string; estimateBytes?: number; estimateKnown: boolean; riskFlags: RiskFlag[] };

type CatalogAction = {
  id: string;
  label: string;
  description: string;
  os: string;
  subActions?: SubAction[];
  available: boolean;
  unavailableReason?: string;
  estimateBytes?: number;
  estimateKnown: boolean;
  estimateDetail?: string;
  riskFlags: RiskFlag[];
  affectsVolumes: string[];
};

type Catalog = { catalogVersion: number; actions: CatalogAction[]; volumesBefore: Array<{ mount: string; freeBytes: number }> };

type RunProjection = {
  cleanupRunId: string;
  status: "running" | "executed" | "failed";
  error: string | null;
  freedBytes: number;
  actions: Array<{ id: string; status: string; exitCode?: number; error?: string }>;
  volumes: Array<{ mount: string; freeBefore: number; freeAfter: number }>;
};

const POLL_INTERVAL_MS = 2_000;
const LIST_POLL_TIMEOUT_MS = 6 * 60 * 1000;
const RUN_POLL_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * OS-native cleanup (Disk Cleanup v2 §8).
 *
 * The panel owns its own polling rather than the tab's shared command-poll
 * hook: it polls W04's own endpoints, which answer `409 agent_update_required`
 * — a branch the generic command poll has no concept of. Every loop is tied
 * to an AbortController AND a mounted ref, because the defect this whole spec
 * was written against included a poll loop that outlived its component.
 */
export default function SystemCleanupPanel({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation("devices");

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | "list" | "run">(null);
  const [error, setError] = useState<string | null>(null);
  const [minAgentVersion, setMinAgentVersion] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [run, setRun] = useState<RunProjection | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });

  const readAgentUpdate = (err: unknown): string | null => {
    if (!(err instanceof ActionError) || err.status !== 409) return null;
    const body = err.body as { error?: string; minAgentVersion?: string } | undefined;
    return body?.error === "agent_update_required" ? (body.minAgentVersion ?? "") : null;
  };

  const handleFailure = useCallback((err: unknown, fallback: string) => {
    // Two different 409s share a status code and must not share an answer:
    // `agent_update_required` raises the update banner and disables Run
    // permanently; `run_in_progress` (spec §13 #4) is transient and the right
    // advice is "wait for the one that is running".
    if (err instanceof ActionError && err.status === 409) {
      const body = err.body as { error?: string } | undefined;
      if (body?.error === 'run_in_progress') {
        setError(t("systemCleanupPanel.runInProgress"));
        return;
      }
    }
    const version = readAgentUpdate(err);
    if (version !== null) {
      setMinAgentVersion(version);
      setError(null);
      return;
    }
    if (err instanceof ActionError && err.status === 401) return; // the auth redirect owns this
    setError(err instanceof Error ? err.message : fallback);
  }, [t]);

  const checkActions = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setBusy("list");
    setError(null);
    setMinAgentVersion(null);
    setRun(null);
    try {
      const queued = await runAction<{ data: { commandId: string } }>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/system-cleanup/list`, { method: "POST" }),
        errorFallback: t("systemCleanupPanel.listFailed"),
      });

      const startedAt = Date.now();
      while (Date.now() - startedAt < LIST_POLL_TIMEOUT_MS) {
        if (!mounted.current) return;
        const response = await fetchWithAuth(
          `/devices/${deviceId}/filesystem/system-cleanup/list/${queued.data.commandId}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (response.status === 409) {
          setMinAgentVersion(body?.minAgentVersion ?? "");
          return;
        }
        if (!response.ok) throw new Error(body?.error || t("systemCleanupPanel.listFailed"));

        if (body.data.status === "completed") {
          if (!mounted.current) return;
          setCatalog(body.data.catalog as Catalog);
          setSelected(new Set());
          return;
        }
        if (body.data.status === "failed") throw new Error(body.data.error || t("systemCleanupPanel.listFailed"));
        await sleep(POLL_INTERVAL_MS, controller.signal);
      }
      throw new Error(t("systemCleanupPanel.listTimedOut"));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      handleFailure(err, t("systemCleanupPanel.listFailed"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [deviceId, handleFailure, t]);

  const selectedActions = useMemo(
    () => (catalog?.actions ?? []).flatMap((action) =>
      action.subActions?.length
        ? action.subActions.map((sub) => ({ ...sub, riskFlags: [...action.riskFlags, ...sub.riskFlags] }))
        : [action],
    ).filter((action) => selected.has(action.id)),
    [catalog, selected],
  );

  // Spec §13 #15. Irreversible losses each have their own sentence in the
  // dialog: uninstalled packages, driver rollback, the Windows "go back"
  // window, and a Mac's only on-disk restore points. Any of them arms the
  // second checkbox — one generic "are you sure" cannot say WHICH thing is
  // about to become unrecoverable, and that is the whole value of the step.
  const ACKNOWLEDGED_RISKS: RiskFlag[] = [
    "removes_packages",
    "removes_driver_rollback",
    "removes_os_rollback",
    "removes_recovery_points",
  ];
  const consequences = ACKNOWLEDGED_RISKS.filter((flag) =>
    selectedActions.some((action) => action.riskFlags.includes(flag)),
  );
  const needsAcknowledgement = consequences.length > 0;

  const executeRun = useCallback(async () => {
    setConfirmOpen(false);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setBusy("run");
    setError(null);
    setElapsedMs(0);
    const startedAt = Date.now();
    try {
      const queued = await runAction<{ data: { cleanupRunId: string } }>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/system-cleanup/run`, {
          method: "POST",
          body: JSON.stringify({ actionIds: selectedActions.map((action) => action.id) }),
        }),
        errorFallback: t("systemCleanupPanel.runFailed"),
      });

      setRun({ cleanupRunId: queued.data.cleanupRunId, status: "running", error: null, freedBytes: 0, actions: [], volumes: [] });

      while (Date.now() - startedAt < RUN_POLL_TIMEOUT_MS) {
        if (!mounted.current) return;
        setElapsedMs(Date.now() - startedAt);
        const response = await fetchWithAuth(
          `/devices/${deviceId}/filesystem/system-cleanup/run/${queued.data.cleanupRunId}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (response.status === 409) {
          setMinAgentVersion(body?.minAgentVersion ?? "");
          return;
        }
        if (!response.ok) throw new Error(body?.error || t("systemCleanupPanel.runFailed"));

        if (!mounted.current) return;
        setRun(body.data as RunProjection);
        if (body.data.status === "failed") {
          setError(body.data.error || t("systemCleanupPanel.runFailed"));
        }
        if (body.data.status !== "running") return;
        await sleep(POLL_INTERVAL_MS, controller.signal);
      }
      throw new Error(t("systemCleanupPanel.runTimedOut"));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      handleFailure(err, t("systemCleanupPanel.runFailed"));
    } finally {
      if (mounted.current) { setBusy(null); setAcknowledged(false); }
    }
  }, [deviceId, handleFailure, selectedActions, t]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const estimateLabel = (action: { estimateKnown: boolean; estimateBytes?: number; estimateDetail?: string }) =>
    action.estimateKnown
      ? action.estimateDetail?.startsWith("heuristic:")
        ? formatBytes(action.estimateBytes ?? 0)
        : t("systemCleanupPanel.estimateUpTo", { size: formatBytes(action.estimateBytes ?? 0) })
      : t("systemCleanupPanel.estimateUnknown");

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Wrench className="h-4 w-4" aria-hidden="true" />
            {t("systemCleanupPanel.title")}
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("systemCleanupPanel.description")}</p>
        </div>
        <button
          type="button"
          data-testid="system-cleanup-check"
          onClick={() => void checkActions()}
          disabled={busy !== null || minAgentVersion !== null}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-slate-600"
        >
          {busy === "list" ? t("systemCleanupPanel.checking") : t("systemCleanupPanel.checkActions")}
        </button>
      </header>

      {minAgentVersion !== null && (
        <div data-testid="system-cleanup-agent-update" role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {t("systemCleanupPanel.agentUpdateRequired", { version: minAgentVersion })}
        </div>
      )}

      {error && (
        <div data-testid="system-cleanup-error" role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {catalog && catalog.actions.length === 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("systemCleanupPanel.noActions")}</p>
      )}

      {catalog && catalog.actions.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {catalog.actions.map((action) => (
            <li key={action.id} data-testid={`system-cleanup-row-${action.id}`} className="flex items-start gap-3 py-2">
              {!action.subActions?.length && <input
                type="checkbox"
                className="mt-1"
                data-testid={`system-cleanup-check-${action.id}`}
                checked={selected.has(action.id)}
                disabled={!action.available || busy !== null}
                onChange={() => toggle(action.id)}
                aria-label={action.label}
              />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-xs font-medium ${action.available ? "text-slate-900 dark:text-slate-100" : "text-slate-400 dark:text-slate-500"}`}>
                    {action.label}
                  </span>
                  {action.riskFlags.map((flag) => (
                    <span
                      key={flag}
                      data-testid={`system-cleanup-risk-${action.id}-${flag}`}
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
                    >
                      {t(/* i18n-dynamic */ `systemCleanupPanel.risk.${flag}`)}
                    </span>
                  ))}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{action.description}</p>
                {action.estimateDetail && (
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{action.estimateDetail}</p>
                )}
                {Boolean(action.subActions?.length) && (
                  <ul aria-label={action.label} className="mt-2 space-y-2">
                    {action.subActions!.map((sub) => (
                      <li key={sub.id} className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1"
                          data-testid={`system-cleanup-check-${sub.id}`}
                          checked={selected.has(sub.id)}
                          disabled={!action.available || busy !== null}
                          onChange={() => toggle(sub.id)}
                          aria-label={sub.label}
                        />
                        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
                          <span className="text-xs">{sub.label}</span>
                          {sub.riskFlags.map((flag) => (
                            <span key={flag} data-testid={`system-cleanup-risk-${sub.id}-${flag}`} className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                              {t(/* i18n-dynamic */ `systemCleanupPanel.risk.${flag}`)}
                            </span>
                          ))}
                        </div>
                        <span data-testid={`system-cleanup-estimate-${sub.id}`} className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
                          {estimateLabel(sub)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {!action.available && action.unavailableReason && (
                  <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">{action.unavailableReason}</p>
                )}
              </div>
              <span data-testid={`system-cleanup-estimate-${action.id}`} className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
                {estimateLabel(action)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {(catalog && catalog.actions.length > 0 || minAgentVersion !== null) && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            data-testid="system-cleanup-run"
            onClick={() => { setAcknowledged(false); setConfirmOpen(true); }}
            disabled={busy !== null || selected.size === 0 || minAgentVersion !== null}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {t("systemCleanupPanel.run")}
          </button>
        </div>
      )}

      {busy === "run" && run?.status === "running" && (
        <p data-testid="system-cleanup-running" className="mt-3 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t("systemCleanupPanel.running", { minutes: Math.floor(elapsedMs / 60_000), seconds: Math.floor((elapsedMs % 60_000) / 1_000) })}
        </p>
      )}

      {run && run.status !== "running" && (
        <div data-testid="system-cleanup-result" className="mt-3 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-700">
          <p className="font-medium">{t("systemCleanupPanel.freed", { size: formatBytes(run.freedBytes) })}</p>
          <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
            {run.volumes.map((volume) => (
              <li key={volume.mount} data-testid={`system-cleanup-volume-${volume.mount}`}>
                {t("systemCleanupPanel.volumeFreed", { mount: volume.mount, size: formatBytes(Math.max(0, volume.freeAfter - volume.freeBefore)) })}
              </li>
            ))}
          </ul>
          <ul className="mt-2 space-y-0.5">
            {run.actions.map((action) => (
              <li key={action.id} data-testid={`system-cleanup-result-${action.id}`} className={action.status === "completed" ? "text-slate-600 dark:text-slate-300" : "text-amber-700 dark:text-amber-300"}>
                {`${action.id}: ${t(/* i18n-dynamic */ `systemCleanupPanel.status.${action.status}`)}`}
                {action.error ? ` — ${action.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void executeRun()}
        variant="destructive"
        title={t("systemCleanupPanel.confirmTitle")}
        message={t("systemCleanupPanel.confirmMessage", { count: selectedActions.length })}
        confirmLabel={t("systemCleanupPanel.run")}
        confirmTestId="system-cleanup-confirm"
        dialogTestId="system-cleanup-confirm-dialog"
        confirmDisabled={needsAcknowledgement && !acknowledged}
      >
        {needsAcknowledgement && (
          <>
            <ul data-testid="system-cleanup-consequences" className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {consequences.map((flag) => (
                <li key={flag} data-testid={`system-cleanup-consequence-${flag}`}>
                  {t(/* i18n-dynamic */ `systemCleanupPanel.consequence.${flag}`)}
                </li>
              ))}
            </ul>
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="system-cleanup-ack-irreversible"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>{t("systemCleanupPanel.confirmIrreversible")}</span>
            </label>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
