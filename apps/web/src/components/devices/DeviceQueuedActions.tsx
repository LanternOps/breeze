import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Clock } from "lucide-react";
import { fetchWithAuth } from "@/stores/auth";
import { runAction, ActionError } from "@/lib/runAction";
import { formatDateTime } from "@/lib/dateTimeFormat";
import "../../lib/i18n";

type QueuedCommand = {
  id: string;
  type: string;
  createdAt: string;
  executedAt?: string | null;
  deliverBy: string | null;
  createdBy: string | null;
};

// #8296 — mirrors POWER_STATE_BARRIER_TYPES (apps/api/src/services/
// commandClaimEligibility.ts): these are held at claim time while any
// delivered (`sent`) command is still running on the device.
const POWER_COMMAND_TYPES = new Set(["reboot", "shutdown", "reboot_safe_mode"]);

// Mirrors MARK_FAILED_MIN_AGE_MS on POST /devices/:id/commands/:cmdId/mark-failed.
// The server enforces it (409 TOO_RECENT); this only decides whether to show
// the button or the "in N min" hint.
const MARK_FAILED_MIN_AGE_MINUTES = 10;

function runningMinutes(command: QueuedCommand, now: number): number {
  const startedAt = Date.parse(command.executedAt ?? command.createdAt);
  if (Number.isNaN(startedAt)) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 60_000));
}

type DeviceQueuedActionsProps = {
  deviceId: string;
};

// No i18n catalog for the raw `device_commands.type` values (dozens of them,
// most never reach `pending` for long — see commandOfflinePolicy.ts's
// registry) — humanize the snake_case type instead of maintaining a parallel
// translated list that would drift from it.
function humanizeCommandType(type: string): string {
  return type
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// #5128 W2 — the device page's "Queued actions" list: pending device_commands
// rows for this device, with a Cancel affordance. Hidden entirely when there
// is nothing queued (design §H) — including while the initial fetch is still
// in flight, so there's no empty-frame flash on every device page load.
export default function DeviceQueuedActions({ deviceId }: DeviceQueuedActionsProps) {
  const { t } = useTranslation("devices");
  const [rows, setRows] = useState<QueuedCommand[]>([]);
  const [loaded, setLoaded] = useState(false);
  // A load FAILURE (non-401 HTTP error, thrown fetch, bad body) is not the
  // same state as "this device genuinely has nothing queued" — collapsing
  // them (both rendering nothing) would tell an operator a device has no
  // pending work when the truth is "we couldn't check". Only the 401 case
  // stays silent: the auth redirect owns telling the user about that one.
  const [loadError, setLoadError] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  // #8296 — delivered commands still running on the device. Only fetched when
  // a power command is queued, because that is the only case where they hold
  // something back.
  const [runningRows, setRunningRows] = useState<QueuedCommand[]>([]);
  const [markingIds, setMarkingIds] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  // The running commands are supplementary: a failure to load them hides the
  // hold banner but must not turn the queued list itself into an error state.
  const loadRunning = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/commands?status=sent&limit=50`);
      if (!res.ok) {
        if (res.status !== 401) {
          console.error(`[DeviceQueuedActions] failed to load running commands: HTTP ${res.status}`);
        }
        setRunningRows([]);
        return;
      }
      const json = await res.json();
      setRunningRows(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      console.error('[DeviceQueuedActions] failed to load running commands', err);
      setRunningRows([]);
    }
  }, [deviceId]);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/commands?status=pending&limit=50`);
      if (res.status === 401) {
        return;
      }
      if (!res.ok) {
        console.error(`[DeviceQueuedActions] failed to load pending commands: HTTP ${res.status}`);
        setLoadError(true);
        setRows([]);
        setRunningRows([]);
        return;
      }
      const json = await res.json();
      const data: QueuedCommand[] = Array.isArray(json?.data) ? json.data : [];
      setRows(data);
      if (data.some((row) => POWER_COMMAND_TYPES.has(row.type))) {
        await loadRunning();
      } else {
        setRunningRows([]);
      }
      setNow(Date.now());
    } catch (err) {
      console.error('[DeviceQueuedActions] failed to load pending commands', err);
      setLoadError(true);
      setRows([]);
      setRunningRows([]);
    } finally {
      setLoaded(true);
    }
  }, [deviceId, loadRunning]);

  useEffect(() => {
    setLoaded(false);
    setLoadError(false);
    setRows([]);
    setRunningRows([]);
    void load();
  }, [load]);

  const heldPowerRow = rows.find((row) => POWER_COMMAND_TYPES.has(row.type));
  const showHold = !loadError && !!heldPowerRow && runningRows.length > 0;

  // Keep the "running for N min" age and the Mark failed eligibility current
  // while the banner is on screen.
  useEffect(() => {
    if (!showHold) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [showHold]);

  const handleMarkFailed = async (commandId: string) => {
    if (markingIds.has(commandId)) return;
    setMarkingIds((prev) => new Set(prev).add(commandId));
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${deviceId}/commands/${commandId}/mark-failed`, { method: "POST" }),
        errorFallback: t("queuedActions.powerHold.markFailedFailed"),
        successMessage: t("queuedActions.powerHold.markedFailed"),
      });
      void load();
    } catch (err) {
      // 409 means the row is no longer running (its result landed, or the
      // reaper got there first) or it is younger than the server allows —
      // reload so the banner reflects the device's real state. Any
      // ActionError was already toasted by runAction; 401 belongs to the
      // auth redirect.
      if (err instanceof ActionError && err.status === 409) {
        void load();
      }
    } finally {
      setMarkingIds((prev) => {
        const next = new Set(prev);
        next.delete(commandId);
        return next;
      });
    }
  };

  const handleCancel = async (commandId: string) => {
    if (cancellingIds.has(commandId)) return;
    setCancellingIds((prev) => new Set(prev).add(commandId));
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${deviceId}/commands/${commandId}/cancel`, { method: "POST" }),
        errorFallback: t("queuedActions.cancelFailed"),
        successMessage: t("queuedActions.cancelled"),
      });
      setRows((prev) => prev.filter((row) => row.id !== commandId));
    } catch (err) {
      // 409 means the agent claimed the row between this list load and the
      // click — reload so the (no-longer-pending) row is dropped from view
      // instead of leaving a Cancel button on work that can't be cancelled.
      // Any other ActionError was already toasted by runAction.
      if (err instanceof ActionError && err.status === 409) {
        void load();
      }
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(commandId);
        return next;
      });
    }
  };

  if (!loaded) return null;
  // Genuinely empty (no error) stays hidden entirely (design §H). A load
  // failure is handled below instead — it must never look identical to
  // "nothing queued".
  if (!loadError && rows.length === 0) return null;

  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="device-queued-actions">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{t("queuedActions.title")}</h3>
      </div>
      {showHold && heldPowerRow && (
        <div
          role="status"
          data-testid="power-hold-banner"
          className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
        >
          <p className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("queuedActions.powerHold.title", { action: humanizeCommandType(heldPowerRow.type) })}
          </p>
          <ul className="mt-2 space-y-2">
            {runningRows.map((running) => {
              const minutes = runningMinutes(running, now);
              const eligible = minutes >= MARK_FAILED_MIN_AGE_MINUTES;
              return (
                <li
                  key={running.id}
                  data-testid="power-hold-running-row"
                  className="flex items-center justify-between gap-3"
                >
                  <p className="min-w-0 text-xs text-muted-foreground">
                    {t("queuedActions.powerHold.body", {
                      action: humanizeCommandType(heldPowerRow.type),
                      command: humanizeCommandType(running.type),
                      minutes,
                    })}
                    {!eligible && (
                      <>
                        {" "}
                        {t("queuedActions.powerHold.markFailedIn", {
                          minutes: MARK_FAILED_MIN_AGE_MINUTES - minutes,
                        })}
                      </>
                    )}
                  </p>
                  {eligible && (
                    <button
                      type="button"
                      data-testid="power-hold-mark-failed"
                      onClick={() => handleMarkFailed(running.id)}
                      disabled={markingIds.has(running.id)}
                      className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      {t("queuedActions.powerHold.markFailed")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {loadError ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("queuedActions.loadFailed")}{" "}
          <button
            type="button"
            data-testid="queued-actions-retry"
            onClick={() => void load()}
            className="font-medium text-primary hover:underline"
          >
            {t("common:actions.retry")}
          </button>
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="queued-action-row"
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{humanizeCommandType(row.type)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {/* `createdBy` is a bare user id (no name join on this
                      endpoint) — a raw UUID would be meaningless to an
                      operator, so this only distinguishes human- from
                      system-initiated, not who specifically. */}
                  {t("queuedActions.requestedBy", {
                    who: row.createdBy ? t("queuedActions.aUser") : t("queuedActions.system"),
                  })}
                  {row.deliverBy && (
                    <>
                      {" · "}
                      {t("queuedActions.expires", { date: formatDateTime(row.deliverBy) })}
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                data-testid="queued-action-cancel"
                onClick={() => handleCancel(row.id)}
                disabled={cancellingIds.has(row.id)}
                className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {t("queuedActions.cancel")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
