// Connected panel: account/last-sync summary, reauth/error banners, and the
// sync/disconnect actions. Split out of UnifiIntegration.tsx (#2382) —
// verbatim move, no behavior change.

import { Loader2, Plug, RefreshCw, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/dateTimeFormat";
import type { UnifiStatus } from "./unifiTypes";

interface ConnectedSummaryCardProps {
  status: UnifiStatus;
  needsReauth: boolean;
  hasError: boolean;
  isCloud: boolean;
  disconnecting: boolean;
  syncing: boolean;
  onSync: () => void;
  onDisconnect: () => void;
}

export default function ConnectedSummaryCard({
  status,
  needsReauth,
  hasError,
  isCloud,
  disconnecting,
  syncing,
  onSync,
  onDisconnect,
}: ConnectedSummaryCardProps) {
  const { t } = useTranslation("integrations");
  return (
    <div
      className="space-y-5 rounded-lg border bg-card p-5"
      data-testid="unifi-connected"
    >
      {/* Degraded states must be loud — a connection in 'error' or 'reauth_required'
          still renders the connected view, but with a prominent banner so the
          operator sees the backend's message instead of silently failing syncs. */}
      {needsReauth && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800"
          data-testid="unifi-reauth-banner"
        >
          <p className="font-medium">
            {t("unifiIntegration.unifiNeedsToBeReconnectedTheStoredAPI")}
          </p>
          {status.lastSyncError && (
            <p
              className="mt-1 text-xs text-amber-700"
              data-testid="unifi-last-error"
            >
              {status.lastSyncError}
            </p>
          )}
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={disconnecting}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="unifi-reconnect"
          >
            {disconnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {t("unifiIntegration.reconnectUniFi")}
          </button>
        </div>
      )}
      {hasError && status.lastSyncError && (
        <p
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          data-testid="unifi-last-error"
        >
          {status.lastSyncError}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground">
            {t("unifiIntegration.account")}
          </dt>
          <dd className="font-medium" data-testid="unifi-account-label">
            {status.accountLabel ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("unifiIntegration.lastSync")}
          </dt>
          <dd className="font-medium" data-testid="unifi-last-sync">
            {status.lastSyncAt
              ? formatDateTime(status.lastSyncAt)
              : t("unifiIntegration.never")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("unifiIntegration.lastSyncStatus")}
          </dt>
          <dd className="font-medium" data-testid="unifi-last-sync-status">
            {status.lastSyncStatus ?? "—"}
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-3 border-t pt-4">
        {isCloud && (
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={syncing}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            data-testid="unifi-sync"
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("unifiIntegration.syncNow")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void onDisconnect()}
          disabled={disconnecting}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          data-testid="unifi-disconnect"
        >
          {disconnecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Unplug className="h-4 w-4" />
          )}
          {t("unifiIntegration.disconnect")}
        </button>
      </div>
    </div>
  );
}
