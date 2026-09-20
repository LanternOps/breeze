import { HardDrive, Loader2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "@/lib/i18n/format";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import type { FilesystemVolume } from "./useFilesystemVolumes";
import "../../../lib/i18n";

type VolumePickerProps = {
  volumes: FilesystemVolume[];
  /** The scan path currently driving every panel below the picker. */
  selectedScanPath: string;
  onSelect: (scanPath: string) => void;
  loading: boolean;
  error?: string;
};

function formatGb(value: number): string {
  return `${formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} GB`;
}

function formatScannedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatUserDateTime(parsed, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The volume selector for the Disk Cleanup tab (spec §8). Selecting a chip
 * re-keys every panel below it; the picker itself owns no data.
 */
export default function VolumePicker({
  volumes,
  selectedScanPath,
  onSelect,
  loading,
  error,
}: VolumePickerProps) {
  const { t } = useTranslation("devices");

  if (loading) {
    return (
      <div
        data-testid="volume-picker-loading"
        className="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("deviceFilesystemTab.volumesLoading")}
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="volume-picker-error"
        role="alert"
        className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        <AlertCircle className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }

  if (volumes.length === 0) {
    return (
      <div
        data-testid="volume-picker-empty"
        className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
      >
        {t("deviceFilesystemTab.volumesEmpty")}
      </div>
    );
  }

  return (
    <div data-testid="volume-picker" className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t("deviceFilesystemTab.volumes")}
      </p>
      <div className="flex flex-wrap gap-2">
        {volumes.map((volume) => {
          const selected = volume.scanPath === selectedScanPath;
          const capacityKnown =
            typeof volume.usedGb === "number" &&
            typeof volume.totalGb === "number" &&
            typeof volume.usedPercent === "number";
          return (
            <button
              key={volume.scanPath}
              type="button"
              data-testid="volume-chip"
              data-volume={volume.scanPath}
              aria-pressed={selected}
              aria-label={t("deviceFilesystemTab.volumeSelectAria", {
                mountPoint: volume.mountPoint,
              })}
              onClick={() => onSelect(volume.scanPath)}
              className={`min-w-[12rem] rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                selected
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted"
              }`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                {volume.mountPoint}
                {volume.isOsRoot && (
                  <span
                    data-testid="volume-os-badge"
                    className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
                  >
                    {t("deviceFilesystemTab.volumeOsBadge")}
                  </span>
                )}
              </span>

              <span data-testid="volume-capacity" className="mt-1 block text-muted-foreground">
                {capacityKnown
                  ? t("deviceFilesystemTab.volumeUsedOfTotal", {
                      used: formatGb(volume.usedGb as number),
                      total: formatGb(volume.totalGb as number),
                    })
                  : t("deviceFilesystemTab.volumeCapacityUnknown")}
              </span>

              {capacityKnown && (
                <span
                  data-testid="volume-usage-bar"
                  className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.min(100, Math.max(0, volume.usedPercent as number))}%` }}
                  />
                </span>
              )}

              <span className="mt-1 block text-muted-foreground">
                {volume.latestSnapshot
                  ? t("deviceFilesystemTab.volumeLastScanned", {
                      when: formatScannedAt(volume.latestSnapshot.capturedAt),
                    })
                  : t("deviceFilesystemTab.volumeNeverScanned")}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
