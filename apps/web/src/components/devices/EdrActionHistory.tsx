import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "@/lib/dateTimeFormat";
import { fetchEdrActions, type EdrActionDto } from "@/lib/edrProviders";
import "@/lib/i18n";

const POLL_MS = 15_000;
const LIMIT = 10;

const isOpen = (r: EdrActionDto) => r.status === "queued" || r.status === "submitted";

type Props = { deviceId: string; /** Bump to refetch (e.g. after an action was requested). */ refreshKey?: number };

export default function EdrActionHistory({ deviceId, refreshKey = 0 }: Props) {
  const { t } = useTranslation("devices");
  const [rows, setRows] = useState<EdrActionDto[]>([]);
  const anyOpen = rows.some(isOpen);
  const cancelled = useRef(false);

  const load = async () => {
    try {
      const next = await fetchEdrActions({ deviceId, limit: LIMIT });
      if (!cancelled.current) setRows(next.slice(0, LIMIT));
    } catch (err) {
      // Keep whatever we had: a transient failure must not blank the ledger
      // (the 15 s poll retries while a row is open). Logged, not toasted.
      console.warn("[EdrActionHistory] failed to load response-action history", err);
    }
  };

  useEffect(() => {
    cancelled.current = false;
    void load();
    return () => {
      cancelled.current = true;
    };
  }, [deviceId, refreshKey]);

  useEffect(() => {
    if (!anyOpen) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyOpen, deviceId]);

  if (rows.length === 0) return null;

  return (
    <div className="mt-4" data-testid="edr-action-history">
      <h5 className="mb-2 text-xs font-semibold text-muted-foreground">
        {t("deviceEdrGenericSection.history.heading")}
      </h5>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li
            key={r.id}
            data-testid={`edr-action-row-${r.id}`}
            className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
          >
            <span className="font-medium">
              {t(/* i18n-dynamic */ `deviceEdrGenericSection.actions.label.${r.action}`, { defaultValue: r.action })}
            </span>
            <span data-testid={`edr-action-status-${r.id}`} className="text-muted-foreground">
              {r.outcomeUnknown
                ? t("deviceEdrGenericSection.history.checking")
                : t(/* i18n-dynamic */ `deviceEdrGenericSection.history.status.${r.status}`)}
            </span>
            {r.requestedVia === "ai" && (
              <span
                data-testid={`edr-action-ai-${r.id}`}
                className="rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-700"
              >
                {t("deviceEdrGenericSection.history.aiBadge")}
              </span>
            )}
            <span className="text-muted-foreground" title={r.requestedBy ?? undefined}>
              {r.requestedBy ? r.requestedBy.slice(0, 8) : "—"}
            </span>
            <span className="ml-auto text-muted-foreground">{formatRelativeTime(r.requestedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
