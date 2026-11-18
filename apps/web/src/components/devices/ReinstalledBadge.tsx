import { useTranslation } from "react-i18next";
import { RefreshCcw } from "lucide-react";
import { formatDate, formatDateTime } from "@/lib/dateTimeFormat";
import type { Device } from "./DeviceList";
import "../../lib/i18n";

/**
 * "Reinstalled on <date>" (#8318 §8 "Web"): this record took over a reinstalled
 * machine, so its inventory was rebuilt by the new install and the old
 * install's queued work, grants and sessions were cancelled. Renders nothing
 * for a record never reattached, which is nearly every device.
 */
export default function ReinstalledBadge({ lastReattachedAt }: Pick<Device, "lastReattachedAt">) {
  const { t } = useTranslation("devices");
  if (!lastReattachedAt) return null;
  const at = new Date(lastReattachedAt);
  if (Number.isNaN(at.getTime())) return null;
  return (
    <span
      data-testid="device-reinstalled-badge"
      title={t("reinstalledBadge.title", { at: formatDateTime(at) })}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
    >
      <RefreshCcw className="h-3 w-3" aria-hidden="true" />
      {t("reinstalledBadge.label", { date: formatDate(at) })}
    </span>
  );
}
