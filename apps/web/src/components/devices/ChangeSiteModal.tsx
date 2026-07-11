import { useState, useEffect } from "react";
import { X, Loader2, MapPin } from "lucide-react";
import type { Device } from "./DeviceList";
import { Dialog } from "../shared/Dialog";
import { fetchWithAuth } from "../../stores/auth";
import { extractApiError } from "@/lib/apiError";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type Site = {
  id: string;
  name: string;
  orgId?: string;
};

type ChangeSiteModalProps = {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export default function ChangeSiteModal({
  device,
  isOpen,
  onClose,
  onSaved,
}: ChangeSiteModalProps) {
  const { t } = useTranslation("devices");
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(device.siteId);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;

    setSiteId(device.siteId);
    setError(undefined);
    setLoading(true);

    // Fetch only sites in the device's org — the API rejects cross-org moves,
    // so listing other orgs' sites would just create a dead-end choice.
    fetchWithAuth(`/orgs/sites?organizationId=${device.orgId}`)
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error("Failed to load sites")),
      )
      .then((data) => {
        const list: Site[] = Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.sites)
            ? data.sites
            : Array.isArray(data)
              ? data
              : [];
        setSites(list);
      })
      .catch((err) => {
        setSites([]);
        setError(
          err instanceof Error
            ? err.message
            : t("changeSiteModal.failedToLoadSites"),
        );
      })
      .finally(() => setLoading(false));
  }, [isOpen, device.orgId, device.siteId]);

  const handleSave = async () => {
    if (siteId === device.siteId) {
      onClose();
      return;
    }

    setSaving(true);
    setError(undefined);

    try {
      const res = await fetchWithAuth(`/devices/${device.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(extractApiError(data, "Failed to change site"));
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("changeSiteModal.failedToChangeSite"),
      );
    } finally {
      setSaving(false);
    }
  };

  const currentSiteName =
    sites.find((s) => s.id === device.siteId)?.name ?? device.siteName;
  const selectionChanged = siteId !== device.siteId;
  const onlyOneSite = sites.length === 1 && sites[0]?.id === device.siteId;

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={t("changeSiteModal.changeSite")}
      className="p-6"
      maxWidth="md"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            <MapPin className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">
            {t("changeSiteModal.changeSite")}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("changeSiteModal.move")}{" "}
        <span className="font-medium text-foreground">
          {device.displayName || device.hostname}
        </span>{" "}
        {t("changeSiteModal.toADifferentSiteWithin")}{" "}
        <span className="font-medium text-foreground">{device.orgName}</span>.
      </p>

      <div className="mt-5 space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {t("changeSiteModal.currentSite")}
          </label>
          <p className="mt-1 text-sm">{currentSiteName || "—"}</p>
        </div>

        <div>
          <label
            htmlFor="change-site-select"
            className="text-xs font-medium text-muted-foreground"
          >
            {t("changeSiteModal.newSite")}{" "}
          </label>
          {loading ? (
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("changeSiteModal.loadingSites")}{" "}
            </div>
          ) : onlyOneSite ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t("changeSiteModal.thisOrganizationOnlyHasOneSite")}{" "}
            </p>
          ) : (
            <select
              id="change-site-select"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              disabled={saving || sites.length === 0}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                  {site.id === device.siteId
                    ? t("changeSiteModal.current")
                    : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("changeSiteModal.cancel")}{" "}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading || !selectionChanged}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("changeSiteModal.moving")}{" "}
            </>
          ) : (
            "Move device"
          )}
        </button>
      </div>
    </Dialog>
  );
}
