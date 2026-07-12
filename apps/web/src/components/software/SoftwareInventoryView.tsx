import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { toCsv } from "@/lib/csvExport";

type InventoryItem = {
  id: string;
  device: string;
  software: string;
  version: string;
  vendor: string;
  installDate: string;
  managed: boolean;
};
function formatDate(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString([], { timeZone: timezone });
}
function normalizeInventoryItem(
  raw: Record<string, unknown>,
  index: number,
): InventoryItem {
  return {
    id: String(raw.id ?? raw.softwareId ?? `inv-${index}`),
    device: String(raw.device ?? raw.deviceName ?? raw.hostname ?? "Unknown"),
    software: String(raw.software ?? raw.name ?? raw.softwareName ?? "Unknown"),
    version: String(raw.version ?? ""),
    vendor: String(raw.vendor ?? ""),
    installDate: String(
      raw.installDate ?? raw.installedAt ?? raw.installAt ?? "",
    ),
    managed: Boolean(raw.managed ?? raw.isManaged ?? false),
  };
}
interface SoftwareInventoryViewProps {
  timezone?: string;
}
export default function SoftwareInventoryView({
  timezone,
}: SoftwareInventoryViewProps) {
  useTranslation("policies");
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [deviceFilter, setDeviceFilter] = useState<string>("all");
  const [managedFilter, setManagedFilter] = useState<string>("all");
  const [uninstallTarget, setUninstallTarget] = useState<InventoryItem | null>(
    null,
  );
  const [uninstalling, setUninstalling] = useState(false);
  const fetchInventory = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth("/software/inventory");
      if (!response.ok) {
        throw new Error(
          i18n.t(
            "policies:software.softwareInventoryView.failedToFetchSoftwareInventory",
          ),
        );
      }
      const payload = await response.json();
      const rawList =
        payload.data ?? payload.inventory ?? payload.items ?? payload ?? [];
      // Handle nested inventory structure (inventory per device)
      let flatList: Record<string, unknown>[] = [];
      if (Array.isArray(rawList)) {
        for (const entry of rawList) {
          if (entry && typeof entry === "object") {
            const record = entry as Record<string, unknown>;
            // If entry has items array, it's a device inventory wrapper
            if (Array.isArray(record.items)) {
              const deviceName = record.deviceName ?? record.device ?? "";
              flatList.push(
                ...record.items.map((item: Record<string, unknown>) => ({
                  ...item,
                  device: item.device ?? deviceName,
                })),
              );
            } else {
              flatList.push(record);
            }
          }
        }
      }
      const normalizedList = flatList.map((item, index) =>
        normalizeInventoryItem(item, index),
      );
      setInventory(normalizedList);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to fetch software inventory",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);
  const devices = useMemo(() => {
    const unique = new Set(inventory.map((item) => item.device));
    return Array.from(unique).sort();
  }, [inventory]);
  const filteredInventory = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inventory.filter((item) => {
      const matchesQuery =
        normalized.length === 0 ||
        item.software.toLowerCase().includes(normalized) ||
        item.vendor.toLowerCase().includes(normalized) ||
        item.version.toLowerCase().includes(normalized);
      const matchesDevice =
        deviceFilter === "all" ? true : item.device === deviceFilter;
      const matchesManaged =
        managedFilter === "all"
          ? true
          : managedFilter === "managed"
            ? item.managed
            : !item.managed;
      return matchesQuery && matchesDevice && matchesManaged;
    });
  }, [inventory, query, deviceFilter, managedFilter]);
  const handleUninstall = (item: InventoryItem) => {
    setUninstallTarget(item);
  };
  const handleConfirmUninstall = async () => {
    if (!uninstallTarget) return;
    setUninstalling(true);
    try {
      // Find the device ID from the inventory
      const deviceId = uninstallTarget.id.split("-")[0] ?? uninstallTarget.id;
      const softwareId = uninstallTarget.id;
      const response = await fetchWithAuth(
        `/software/inventory/${deviceId}/${softwareId}/uninstall`,
        {
          method: "POST",
          body: JSON.stringify({
            requestedBy: "current-user",
            reason: i18n.t(
              "policies:software.softwareInventoryView.manualUninstallRequest",
            ),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          i18n.t(
            "policies:software.softwareInventoryView.failedToQueueUninstall",
          ),
        );
      }
      // Remove from local state
      setInventory((prev) =>
        prev.filter((entry) => entry.id !== uninstallTarget.id),
      );
      setUninstallTarget(null);
    } catch (err) {
      console.error("Uninstall failed:", err);
      setError(
        i18n.t(
          "policies:software.softwareInventoryView.failedToUninstallSoftwarePleaseTryAgain",
        ),
      );
    } finally {
      setUninstalling(false);
    }
  };
  const handleExport = () => {
    const header = [
      "Device",
      "Software",
      "Version",
      "Vendor",
      "Install Date",
      "Managed",
    ];
    const rows = filteredInventory.map((item) => [
      item.device,
      item.software,
      item.version,
      item.vendor,
      item.installDate,
      item.managed ? "Yes" : "No",
    ]);
    // Neutralize spreadsheet-formula injection from agent-supplied fields
    // (software/version/vendor) before quoting.
    const csvContent = toCsv(header, rows);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "software-inventory.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.softwareInventoryView.loadingSoftwareInventory",
            )}
          </p>
        </div>
      </div>
    );
  }
  if (error && inventory.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchInventory}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {i18n.t("policies:software.softwareInventoryView.tryAgain")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {i18n.t(
              "policies:software.softwareInventoryView.softwareInventory",
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.softwareInventoryView.trackInstalledSoftwareAcrossManagedDevices",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          {i18n.t("policies:software.softwareInventoryView.exportCSV")}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-xs lg:grid-cols-[1.5fr_1fr_1fr]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={i18n.t(
              "policies:software.softwareInventoryView.searchSoftwareVendorVersion",
            )}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={deviceFilter}
          onChange={(event) => setDeviceFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">
            {i18n.t("policies:software.softwareInventoryView.allDevices")}
          </option>
          {devices.map((device) => (
            <option key={device} value={device}>
              {device}
            </option>
          ))}
        </select>
        <select
          value={managedFilter}
          onChange={(event) => setManagedFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">
            {i18n.t("policies:software.softwareInventoryView.allSoftware")}
          </option>
          <option value="managed">
            {i18n.t("policies:software.softwareInventoryView.managedOnly")}
          </option>
          <option value="unmanaged">
            {i18n.t("policies:software.softwareInventoryView.unmanagedOnly")}
          </option>
        </select>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {i18n.t("policies:software.softwareInventoryView.inventoryList")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {filteredInventory.length}
              {i18n.t("policies:software.softwareInventoryView.installations")}
            </p>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  {i18n.t("policies:software.softwareInventoryView.software")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.softwareInventoryView.version")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.softwareInventoryView.vendor")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareInventoryView.installDate",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.softwareInventoryView.managed")}
                </th>
                <th className="px-4 py-3">{i18n.t("common:labels.device")}</th>
                <th className="px-4 py-3 text-right">
                  {i18n.t("common:labels.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredInventory.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    {i18n.t(
                      "policies:software.softwareInventoryView.noInventoryItemsMatchYourSearch",
                    )}
                  </td>
                </tr>
              ) : (
                filteredInventory.map((item) => (
                  <tr key={item.id} className="text-sm">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {item.software}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.version}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.vendor}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(item.installDate, timezone)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                          item.managed
                            ? "bg-emerald-500/20 text-emerald-700 border-emerald-500/40"
                            : "bg-slate-500/20 text-slate-700 border-slate-500/40",
                        )}
                      >
                        {item.managed
                          ? i18n.t(
                              "policies:software.softwareInventoryView.managed",
                            )
                          : i18n.t(
                              "policies:software.softwareInventoryView.unmanaged",
                            )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.device}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleUninstall(item)}
                        className="inline-flex h-8 items-center justify-center gap-1 rounded-md border px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {i18n.t(
                          "policies:software.softwareInventoryView.uninstall",
                        )}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmDialog
        open={uninstallTarget !== null}
        onClose={() => setUninstallTarget(null)}
        onConfirm={handleConfirmUninstall}
        title={i18n.t(
          "policies:software.softwareInventoryView.uninstallSoftware",
        )}
        message={i18n.t("policies:software.softwareInventoryView.confirmUninstall", { software: uninstallTarget?.software, device: uninstallTarget?.device })}
        confirmLabel={i18n.t(
          "policies:software.softwareInventoryView.uninstall",
        )}
        variant="warning"
        isLoading={uninstalling}
      />
    </div>
  );
}
