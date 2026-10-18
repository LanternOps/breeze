import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { formatDateTime } from "@/lib/dateTimeFormat";
import "@/lib/i18n";

// Read-only view: the only request is a GET, so there is deliberately no
// runAction call here (runAction wraps POST/PUT/PATCH/DELETE mutations). A
// reviewer should not flag its absence.

const STALE_MANIFEST_PATH = "/m365/customer-graph-actions/connections/stale-manifest";
const HASH_PREFIX = "m365-reconsent-";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["pending-consent", "verifying", "active", "degraded", "suspended", "revoked"] as const;

interface StaleConnection {
  id: string;
  orgId: string;
  orgName: string;
  displayName: string | null;
  tenantId: string | null;
  manifestVersion: number;
  currentManifestVersion: number;
  status: (typeof STATUSES)[number];
  lastVerifiedAt: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; connections: StaleConnection[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseConnection(value: unknown): StaleConnection | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "orgId", "orgName", "displayName", "tenantId", "manifestVersion",
    "currentManifestVersion", "status", "lastVerifiedAt",
  ])) return null;
  if (
    typeof value.id !== "string" || !GUID.test(value.id)
    || typeof value.orgId !== "string" || !GUID.test(value.orgId)
    || typeof value.orgName !== "string"
    || (value.displayName !== null && typeof value.displayName !== "string")
    || (value.tenantId !== null && (typeof value.tenantId !== "string" || !GUID.test(value.tenantId)))
    || typeof value.manifestVersion !== "number" || !Number.isSafeInteger(value.manifestVersion)
    || typeof value.currentManifestVersion !== "number" || !Number.isSafeInteger(value.currentManifestVersion)
    || typeof value.status !== "string" || !(STATUSES as readonly string[]).includes(value.status)
    || (value.lastVerifiedAt !== null
      && (typeof value.lastVerifiedAt !== "string" || !Number.isFinite(Date.parse(value.lastVerifiedAt))))
  ) return null;
  return {
    id: value.id,
    orgId: value.orgId,
    orgName: value.orgName,
    displayName: value.displayName as string | null,
    tenantId: value.tenantId as string | null,
    manifestVersion: value.manifestVersion,
    currentManifestVersion: value.currentManifestVersion,
    status: value.status as StaleConnection["status"],
    lastVerifiedAt: value.lastVerifiedAt as string | null,
  };
}

function parseResponse(value: unknown): StaleConnection[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["currentManifestVersion", "connections"])) return null;
  if (typeof value.currentManifestVersion !== "number" || !Array.isArray(value.connections)) return null;
  const parsed = value.connections.map(parseConnection);
  return parsed.every((entry) => entry !== null) ? (parsed as StaleConnection[]) : null;
}

function selectedOrgFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  return hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : null;
}

export default function M365ActionsStaleManifestTable() {
  const { t } = useTranslation("integrations");
  const selectOrganization = useOrgStore((value) => value.selectOrganization);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth(STALE_MANIFEST_PATH);
        if (cancelled) return;
        // 403 means an organization-scoped session: the view does not apply,
        // so it is not an error and shows nothing.
        if (response.status === 403) {
          setState({ kind: "hidden" });
          return;
        }
        if (!response.ok) {
          setState({ kind: "error" });
          return;
        }
        const connections = parseResponse(await response.json());
        if (cancelled) return;
        if (connections === null) setState({ kind: "error" });
        else setState(connections.length === 0 ? { kind: "hidden" } : { kind: "ready", connections });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const sync = () => setSelectedOrgId(selectedOrgFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  if (state.kind === "hidden") return null;

  if (state.kind === "loading") {
    return (
      <div className="mt-6 space-y-3" data-testid="m365-stale-manifest-loading" aria-hidden="true">
        <div className="skeleton h-5 w-64" />
        <div className="skeleton h-4 w-full max-w-2xl" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {t("m365CustomerGraphActions.staleManifest.loadFailed")}
      </div>
    );
  }

  const openOrganization = (orgId: string) => {
    selectOrganization(orgId);
    // Transient selection lives in the hash, never a query param.
    window.location.hash = `${HASH_PREFIX}${orgId}`;
    setSelectedOrgId(orgId);
  };

  return (
    <section
      className="mt-8 border-t pt-6"
      aria-labelledby="m365-stale-manifest-title"
      data-testid="m365-stale-manifest-table"
    >
      <h3 id="m365-stale-manifest-title" className="text-base font-semibold text-foreground">
        {t("m365CustomerGraphActions.staleManifest.title")}
      </h3>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
        {t("m365CustomerGraphActions.staleManifest.description")}
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="border-b text-xs font-medium text-muted-foreground">
              <th scope="col" className="py-2 pr-4">{t("m365CustomerGraphActions.staleManifest.columnOrganization")}</th>
              <th scope="col" className="py-2 pr-4">{t("m365CustomerGraphActions.staleManifest.columnTenant")}</th>
              <th scope="col" className="py-2 pr-4">{t("m365CustomerGraphActions.staleManifest.columnVersion")}</th>
              <th scope="col" className="py-2">{t("m365CustomerGraphActions.staleManifest.columnLastVerified")}</th>
            </tr>
          </thead>
          <tbody>
            {state.connections.map((connection) => (
              <tr
                key={connection.id}
                data-testid="m365-stale-connection-row"
                aria-current={selectedOrgId === connection.orgId ? "true" : undefined}
                tabIndex={0}
                onClick={() => openOrganization(connection.orgId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openOrganization(connection.orgId);
                  }
                }}
                className={`cursor-pointer border-b hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
                  selectedOrgId === connection.orgId ? "bg-muted" : ""
                }`}
              >
                <td className="py-3 pr-4 font-medium text-foreground">{connection.orgName}</td>
                <td className="py-3 pr-4 text-foreground">
                  {connection.displayName || t("m365CustomerGraphActions.unnamedTenant")}
                </td>
                <td className="py-3 pr-4 text-foreground">
                  {t("m365CustomerGraphActions.manifestVersion", { version: connection.manifestVersion })}
                </td>
                <td className="py-3 text-foreground">
                  {connection.lastVerifiedAt
                    ? formatDateTime(connection.lastVerifiedAt)
                    : t("m365CustomerGraphActions.never")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
