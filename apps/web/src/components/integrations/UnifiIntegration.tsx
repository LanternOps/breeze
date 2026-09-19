import { AlertTriangle, CheckCircle2, Loader2, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useUnifiIntegration } from "./unifi/useUnifiIntegration";
import ConnectionChooser from "./unifi/ConnectionChooser";
import ConnectedSummaryCard from "./unifi/ConnectedSummaryCard";
import ControllersCard from "./unifi/ControllersCard";
import SiteMappingCard from "./unifi/SiteMappingCard";
import TelemetryCollectorsCard from "./unifi/TelemetryCollectorsCard";
import TelemetryViewerCard from "./unifi/TelemetryViewerCard";
import SyncHistoryCard from "./unifi/SyncHistoryCard";

export default function UnifiIntegration() {
  const { t } = useTranslation("integrations");
  const {
    isOrgScoped,
    status,
    apiKey,
    setApiKey,
    connectMode,
    setConnectMode,
    accountLabel,
    setAccountLabel,
    loading,
    loadError,
    connecting,
    syncing,
    disconnecting,
    hosts,
    hostsLoading,
    hostsError,
    selection,
    setSelection,
    savingMappings,
    syncRuns,
    collectors,
    agents,
    agentsTruncated,
    translateDeviceStatus,
    collectorDrafts,
    savingCollector,
    selfHostedCollectors,
    controllerSites,
    controllerDraft,
    setControllerDraft,
    registeringController,
    savingControllerMappings,
    telemetrySite,
    telemetry,
    telemetryLoading,
    telemetryError,
    detailsError,
    sitesByOrg,
    isConnected,
    isSelfHosted,
    isCloud,
    needsReauth,
    hasError,
    loadHosts,
    loadSelfHosted,
    updateDraft,
    handleSaveMappings,
    handleRegisterController,
    handleSaveControllerMappings,
    handleSaveCollector,
    handleLoadTelemetry,
    handleConnect,
    handleConnectSelfHosted,
    handleSync,
    handleDisconnect,
  } = useUnifiIntegration();

  if (isOrgScoped) {
    return (
      <div className="space-y-6" data-testid="unifi-panel">
        <Header />
        <p
          className="text-center text-sm text-muted-foreground"
          data-testid="unifi-org-scope"
        >
          {t("unifiIntegration.theUniFiNetworkIntegrationIsAvailableToPartner")}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 py-12 text-sm text-muted-foreground"
        data-testid="unifi-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />{" "}
        {t("unifiIntegration.loadingUniFiStatus")}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="unifi-panel">
      <div className="flex items-center gap-3">
        <Header />
        {needsReauth ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700"
            data-testid="unifi-status-reauth"
          >
            <AlertTriangle className="h-3.5 w-3.5" />{" "}
            {t("unifiIntegration.reconnectRequired")}
          </span>
        ) : hasError ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700"
            data-testid="unifi-status-error"
          >
            <AlertTriangle className="h-3.5 w-3.5" />{" "}
            {t("unifiIntegration.syncError")}
          </span>
        ) : isConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700"
            data-testid="unifi-status-connected"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />{" "}
            {t("unifiIntegration.connected")}
          </span>
        ) : (
          <span
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            data-testid="unifi-status-disconnected"
          >
            <Unplug className="h-3.5 w-3.5" /> {t("unifiIntegration.notConnected")}
          </span>
        )}
      </div>

      {loadError && (
        <p
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="unifi-load-error"
        >
          {loadError}
        </p>
      )}

      {detailsError && (
        <p
          className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="unifi-details-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" /> {detailsError}
        </p>
      )}

      {!isConnected && (
        <ConnectionChooser
          connectMode={connectMode}
          setConnectMode={setConnectMode}
          apiKey={apiKey}
          setApiKey={setApiKey}
          accountLabel={accountLabel}
          setAccountLabel={setAccountLabel}
          connecting={connecting}
          onConnect={handleConnect}
          onConnectSelfHosted={handleConnectSelfHosted}
        />
      )}

      {isConnected && status && (
        <ConnectedSummaryCard
          status={status}
          needsReauth={needsReauth}
          hasError={hasError}
          isCloud={isCloud}
          disconnecting={disconnecting}
          syncing={syncing}
          onSync={handleSync}
          onDisconnect={handleDisconnect}
        />
      )}

      {isSelfHosted && (
        <ControllersCard
          selfHostedCollectors={selfHostedCollectors}
          controllerDraft={controllerDraft}
          setControllerDraft={setControllerDraft}
          sitesByOrg={sitesByOrg}
          agents={agents}
          agentsTruncated={agentsTruncated}
          translateDeviceStatus={translateDeviceStatus}
          registeringController={registeringController}
          onRegisterController={handleRegisterController}
        />
      )}

      {isSelfHosted && (
        <SiteMappingCard
          variant="self_hosted"
          controllerSites={controllerSites}
          selection={selection}
          setSelection={setSelection}
          sitesByOrg={sitesByOrg}
          savingControllerMappings={savingControllerMappings}
          onRefresh={loadSelfHosted}
          onSave={handleSaveControllerMappings}
        />
      )}

      {isCloud && (
        <SiteMappingCard
          variant="cloud"
          hosts={hosts}
          hostsLoading={hostsLoading}
          hostsError={hostsError}
          selection={selection}
          setSelection={setSelection}
          sitesByOrg={sitesByOrg}
          savingMappings={savingMappings}
          onRefresh={loadHosts}
          onSave={handleSaveMappings}
        />
      )}

      {isCloud && hosts && hosts.length > 0 && (
        <TelemetryCollectorsCard
          hosts={hosts}
          collectors={collectors}
          collectorDrafts={collectorDrafts}
          agents={agents}
          agentsTruncated={agentsTruncated}
          sitesByOrg={sitesByOrg}
          translateDeviceStatus={translateDeviceStatus}
          savingCollector={savingCollector}
          updateDraft={updateDraft}
          onSaveCollector={handleSaveCollector}
        />
      )}

      {isCloud && (
        <TelemetryViewerCard
          telemetrySite={telemetrySite}
          sitesByOrg={sitesByOrg}
          telemetryLoading={telemetryLoading}
          telemetryError={telemetryError}
          telemetry={telemetry}
          onLoadTelemetry={handleLoadTelemetry}
        />
      )}

      {isCloud && <SyncHistoryCard syncRuns={syncRuns} />}
    </div>
  );
}

function Header() {
  const { t } = useTranslation("integrations");
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <span className="text-sm font-bold">UI</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">
          {t("unifiIntegration.unifiNetwork")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "unifiIntegration.discoverAndReconcileUniFiNetworkAssetsAcrossYour",
          )}
        </p>
      </div>
    </div>
  );
}
