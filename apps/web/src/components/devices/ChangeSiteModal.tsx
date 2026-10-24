import { useState, useEffect, useMemo } from "react";
import { X, Loader2, MapPin } from "lucide-react";
import type { Device } from "./DeviceList";
import { Dialog } from "../shared/Dialog";
import { fetchWithAuth } from "../../stores/auth";
import { fetchAllSites } from "@/lib/fetchAllSites";
import { extractApiError } from "@/lib/apiError";
import { useTranslation } from "react-i18next";
import { ActionError } from "@/lib/runAction";
import { showToast } from "../shared/Toast";
import { moveDevicesToSite, type BulkSiteMoveResponse } from "./bulkSiteMove";
import "../../lib/i18n";

type Site = {
  id: string;
  name: string;
  orgId?: string;
};

/**
 * What the dialog needs to know about the thing being moved. Agent devices
 * pass a `Device` and get this derived; network assets (discovered_assets)
 * build it from the asset page's extras.
 */
export type ChangeSiteSubject = {
  id: string;
  /** Shown in the dialog copy ("Move <name> to a different site…"). */
  name: string;
  orgId: string;
  orgName?: string | null;
  siteId: string;
  siteName?: string | null;
};

/**
 * Performs the write. Rejections are shown inline and keep the dialog open.
 * `siteName` is the chosen site's display name, for the caller's toast.
 */
export type ChangeSiteSubmit = (siteId: string, siteName: string) => Promise<unknown>;

type ChangeSiteModalBaseProps = {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

type SingleChangeSiteProps = ChangeSiteModalBaseProps & (
  | { device: Device; subject?: undefined; submit?: undefined; devices?: undefined }
  | { device?: undefined; subject: ChangeSiteSubject; submit: ChangeSiteSubmit; devices?: undefined }
);

/**
 * Bulk variant (#9796): agent devices of ONE org (the caller gates that — see
 * bulkMoveSiteBlock in bulkActionGating.ts) move through a single
 * POST /devices/bulk/site. `onBulkMoved` receives the per-device 200 body and
 * the target site name so the caller can toast "Moved N of M".
 */
type BulkChangeSiteProps = ChangeSiteModalBaseProps & {
  devices: Device[];
  onBulkMoved: (result: BulkSiteMoveResponse, siteName: string) => void;
  onUnauthorized?: () => void;
  device?: undefined;
  subject?: undefined;
  submit?: undefined;
};

type ChangeSiteModalProps = SingleChangeSiteProps | BulkChangeSiteProps;

function subjectFromDevice(device: Device): ChangeSiteSubject {
  return {
    id: device.id,
    name: device.displayName || device.hostname,
    orgId: device.orgId,
    orgName: device.orgName,
    siteId: device.siteId,
    siteName: device.siteName,
  };
}

// The agent-device write. Kept here (not in a writer hook) so the existing
// device callers are unchanged; network assets pass their own `submit` from
// useNetworkAssetMutations, which is the single writer for that endpoint.
/** Thrown by the device writer on 409 `device_site_changed` (someone else moved it). */
export class DeviceSiteChangedError extends Error {
  readonly status = 409;
  readonly code = "device_site_changed";
  constructor(readonly currentSiteId?: string) {
    super("device_site_changed");
    this.name = "DeviceSiteChangedError";
  }
}

// `expectedSiteId` lets the API reject the write if the device moved since this
// dialog loaded (optimistic concurrency).
function deviceSubmit(deviceId: string, expectedSiteId: string): ChangeSiteSubmit {
  return async (siteId) => {
    const res = await fetchWithAuth(`/devices/${deviceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, expectedSiteId }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.error === "device_site_changed") {
        throw new DeviceSiteChangedError(
          typeof data.currentSiteId === "string" ? data.currentSiteId : undefined,
        );
      }
      throw new Error(extractApiError(data, "Failed to change site"));
    }
    return res;
  };
}

export default function ChangeSiteModal(props: ChangeSiteModalProps) {
  return props.devices
    ? <BulkChangeSiteDialog {...props} />
    : <SingleChangeSiteDialog {...props} />;
}

function SingleChangeSiteDialog(props: SingleChangeSiteProps) {
  const { isOpen, onClose, onSaved } = props;
  const { t } = useTranslation("devices");
  const subject = useMemo(
    () => props.subject ?? subjectFromDevice(props.device as Device),
    [props.subject, props.device],
  );
  const isDeviceVariant = !props.submit;
  const submit = props.submit ?? deviceSubmit(subject.id, subject.siteId);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(subject.siteId);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;

    setSiteId(subject.siteId);
    setError(undefined);
    setLoading(true);

    // Fetch only sites in the subject's org — the API rejects cross-org moves,
    // so listing other orgs' sites would just create a dead-end choice.
    fetchAllSites<Site>(`/orgs/sites?organizationId=${subject.orgId}`)
      .then((list) => {
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
  }, [isOpen, subject.orgId, subject.siteId]);

  const handleSave = async () => {
    if (siteId === subject.siteId) {
      onClose();
      return;
    }

    setSaving(true);
    setError(undefined);

    try {
      await submit(siteId, sites.find((s) => s.id === siteId)?.name ?? "");
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof DeviceSiteChangedError) {
        setError(t("changeSiteModal.deviceMovedByOther"));
        return;
      }
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
    sites.find((s) => s.id === subject.siteId)?.name ?? subject.siteName;
  const selectionChanged = siteId !== subject.siteId;
  const onlyOneSite = sites.length === 1 && sites[0]?.id === subject.siteId;

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
        <span className="font-medium text-foreground">{subject.name}</span>{" "}
        {subject.orgName ? (
          <>
            {t("changeSiteModal.toADifferentSiteWithin")}{" "}
            <span className="font-medium text-foreground">
              {subject.orgName}
            </span>
            .
          </>
        ) : (
          t("changeSiteModal.toADifferentSite")
        )}
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
                  {site.id === subject.siteId
                    ? t("changeSiteModal.current")
                    : ""}
                </option>
              ))}
            </select>
          )}
          {isDeviceVariant && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("changeSiteModal.policyNote", { device: subject.name })}
            </p>
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

/**
 * "Move N devices to a site" (#9796, spec §4.4). One request for the whole selection; the
 * per-device outcomes come back in the 200 body and the CALLER toasts them (onBulkMoved), because
 * a 200 can still mean "none moved". A whole-batch refusal (mixed orgs, an invisible target, MFA,
 * no permission) is already toasted by runAction; the dialog stays open and repeats the reason.
 */
function BulkChangeSiteDialog(props: BulkChangeSiteProps) {
  const { isOpen, onClose, onSaved, onBulkMoved, onUnauthorized, devices } = props;
  const { t } = useTranslation("devices");
  // The caller guarantees one org (bulkMoveSiteBlock); the first row names it.
  const orgId = devices[0]?.orgId ?? "";
  const orgName = devices[0]?.orgName ?? null;
  const sourceSiteIds = useMemo(() => [...new Set(devices.map((d) => d.siteId))], [devices]);
  const singleSourceSiteId = sourceSiteIds.length === 1 ? sourceSiteIds[0]! : null;
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(singleSourceSiteId ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen || !orgId) return;
    setSiteId(singleSourceSiteId ?? "");
    setError(undefined);
    setLoading(true);
    // Only the selection's org: the API refuses a cross-org target (site_org_mismatch), and
    // GET /orgs/sites already narrows to the sites this viewer may reach (allowedSiteIds).
    fetchAllSites<Site>(`/orgs/sites?organizationId=${orgId}`)
      .then((list) => setSites(list))
      .catch((err) => {
        setSites([]);
        setError(err instanceof Error ? err.message : t("changeSiteModal.failedToLoadSites"));
      })
      .finally(() => setLoading(false));
  }, [isOpen, orgId, singleSourceSiteId]);

  const handleSave = async () => {
    if (!siteId || siteId === singleSourceSiteId) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await moveDevicesToSite({
        siteId,
        devices,
        errorFallback: t("changeSiteModal.failedToMoveDevices"),
        onUnauthorized,
      });
      onBulkMoved(result, sites.find((s) => s.id === siteId)?.name ?? "");
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: "error", message: t("changeSiteModal.failedToMoveDevices") });
      }
      // ActionError was already toasted by runAction; keep the dialog open with the reason.
      setError(err instanceof Error ? err.message : t("changeSiteModal.failedToMoveDevices"));
    } finally {
      setSaving(false);
    }
  };

  const singleSourceSiteName = singleSourceSiteId
    ? (sites.find((s) => s.id === singleSourceSiteId)?.name ?? devices[0]?.siteName ?? null)
    : null;
  const canSubmit = !!siteId && siteId !== singleSourceSiteId;
  const onlyOneSite = !!singleSourceSiteId && sites.length === 1 && sites[0]?.id === singleSourceSiteId;

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
          <h2 className="text-lg font-semibold">{t("changeSiteModal.changeSite")}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          aria-label={t("changeSiteModal.cancel")}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        {orgName
          ? t("changeSiteModal.bulkIntro", { count: devices.length, org: orgName })
          : t("changeSiteModal.bulkIntroNoOrg", { count: devices.length })}
      </p>

      <div className="mt-5 space-y-4">
        <div>
          <span className="text-xs font-medium text-muted-foreground">{t("changeSiteModal.currentSite")}</span>
          <p className="mt-1 text-sm" data-testid="change-site-bulk-current">
            {singleSourceSiteId
              ? (singleSourceSiteName || "—")
              : t("changeSiteModal.devicesFromSites", { count: devices.length, siteCount: sourceSiteIds.length })}
          </p>
        </div>

        <div>
          <label htmlFor="change-site-bulk-select" className="text-xs font-medium text-muted-foreground">
            {t("changeSiteModal.newSite")}
          </label>
          {loading ? (
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("changeSiteModal.loadingSites")}
            </div>
          ) : onlyOneSite ? (
            <p className="mt-1 text-sm text-muted-foreground">{t("changeSiteModal.thisOrganizationOnlyHasOneSite")}</p>
          ) : (
            <select
              id="change-site-bulk-select"
              data-testid="change-site-bulk-select"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              disabled={saving || sites.length === 0}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              {!singleSourceSiteId && (
                <option value="" disabled>
                  {t("changeSiteModal.selectSite")}
                </option>
              )}
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                  {site.id === singleSourceSiteId ? t("changeSiteModal.current") : ""}
                </option>
              ))}
            </select>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t("changeSiteModal.bulkPolicyNote")}</p>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
          {t("changeSiteModal.cancel")}
        </button>
        <button
          type="button"
          data-testid="change-site-submit"
          onClick={handleSave}
          disabled={saving || loading || !canSubmit}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("changeSiteModal.moving")}
            </>
          ) : (
            t("changeSiteModal.moveDevices", { count: devices.length })
          )}
        </button>
      </div>
    </Dialog>
  );
}
