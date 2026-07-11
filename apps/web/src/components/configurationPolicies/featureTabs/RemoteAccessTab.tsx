import { useState, useEffect } from "react";
import { Monitor, Network, Gauge, Plus, X } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type RemoteAccessSettings = {
  webrtcDesktop: boolean;
  vncRelay: boolean;
  remoteTools: boolean;
  // Clipboard sync over the WebRTC desktop channel, gated per direction and
  // enforced agent-side. host→viewer is the data-egress direction (off by
  // default on hosted SaaS); viewer→host is operator-initiated paste (on by
  // default). Defaulted here to the self-hosted bidirectional behavior; the
  // API applies its own IS_HOSTED-keyed defaults when no policy is configured.
  clipboardHostToViewer: boolean;
  clipboardViewerToHost: boolean;
  enableProxy: boolean;
  defaultAllowedPorts: number[];
  autoEnableProxy: boolean;
  maxConcurrentTunnels: number;
  idleTimeoutMinutes: number;
  maxSessionDurationHours: number;
};
const defaults: RemoteAccessSettings = {
  webrtcDesktop: true,
  vncRelay: false,
  remoteTools: true,
  clipboardHostToViewer: true,
  clipboardViewerToHost: true,
  enableProxy: false,
  defaultAllowedPorts: [80, 443, 8080, 8443],
  autoEnableProxy: false,
  maxConcurrentTunnels: 5,
  idleTimeoutMinutes: 5,
  maxSessionDurationHours: 8,
};
const idleTimeoutOptions = [1, 2, 5, 10, 15, 30];
const maxSessionOptions = [1, 2, 4, 8, 12, 24];
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border bg-background px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${checked ? "bg-emerald-500/80" : "bg-muted"}`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? "translate-x-5" : "translate-x-1"}`}
        />
      </button>
    </div>
  );
}
export default function RemoteAccessTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
}: FeatureTabProps) {
  useTranslation("policies");
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const [settings, setSettings] = useState<RemoteAccessSettings>(() => {
    const stored = existingLink?.inlineSettings as
      | Partial<RemoteAccessSettings>
      | undefined;
    const merged = { ...defaults, ...stored };
    if (!Array.isArray(merged.defaultAllowedPorts))
      merged.defaultAllowedPorts = [...defaults.defaultAllowedPorts];
    return merged;
  });
  const [newPort, setNewPort] = useState("");
  useEffect(() => {
    if (existingLink?.inlineSettings) {
      setSettings((prev) => {
        const merged = {
          ...prev,
          ...(existingLink.inlineSettings as Partial<RemoteAccessSettings>),
        };
        if (!Array.isArray(merged.defaultAllowedPorts))
          merged.defaultAllowedPorts = [...defaults.defaultAllowedPorts];
        return merged;
      });
    }
  }, [existingLink]);
  const meta = FEATURE_META.remote_access;
  const update = <K extends keyof RemoteAccessSettings>(
    key: K,
    value: RemoteAccessSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const handleAddPort = () => {
    const port = parseInt(newPort.trim(), 10);
    if (
      isNaN(port) ||
      port < 1 ||
      port > 65535 ||
      settings.defaultAllowedPorts.includes(port)
    )
      return;
    update("defaultAllowedPorts", [...settings.defaultAllowedPorts, port]);
    setNewPort("");
  };
  const handleRemovePort = (port: number) =>
    update(
      "defaultAllowedPorts",
      settings.defaultAllowedPorts.filter((p) => p !== port),
    );
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "remote_access",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "remote_access");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "remote_access");
  };
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Monitor className="h-5 w-5" />}
      isConfigured={!!existingLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Desktop Access */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.desktopAccess",
              )}
            </h3>
          </div>
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.remoteDesktop",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.allowTheBreezeViewerToConnectTo",
            )}
            checked={settings.webrtcDesktop}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.webrtcDesktop",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.vNCRelayMacOS",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.allowBrowserBasedVNCConnectionsToReach",
            )}
            checked={settings.vncRelay}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.vncRelay",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.remoteSystemTools",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.allowRemoteProcessManagerServicesRegistryTerminal",
            )}
            checked={settings.remoteTools}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.remoteTools",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.clipboardRemoteViewerCopyFromRemote",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.streamTheRemoteMachineSClipboardTo",
            )}
            checked={settings.clipboardHostToViewer}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.clipboardHostToViewer",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.clipboardViewerRemotePasteToRemote",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.allowTheOperatorToPasteTheirLocal",
            )}
            checked={settings.clipboardViewerToHost}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.clipboardViewerToHost",
                ),
                v,
              )
            }
          />
        </div>

        {/* Limits */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.limits",
              )}
            </h3>
          </div>
          <div className="rounded-md border bg-background px-4 py-3">
            <label className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.maxConcurrentTunnelsPerAgent",
              )}
            </label>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.numberOfSimultaneousTunnelConnectionsAllowed1",
              )}
            </p>
            <input
              type="number"
              min={1}
              max={20}
              value={settings.maxConcurrentTunnels}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 20)
                  update(
                    i18n.t(
                      "policies:configurationPolicies.featureTabs.remoteAccessTab.maxConcurrentTunnels",
                    ),
                    v,
                  );
              }}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="rounded-md border bg-background px-4 py-3">
            <label className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.idleTimeoutMinutes",
              )}
            </label>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.disconnectAfterThisManyMinutesOfInactivity",
              )}
            </p>
            <select
              value={settings.idleTimeoutMinutes}
              onChange={(e) =>
                update(
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.remoteAccessTab.idleTimeoutMinutes2",
                  ),
                  parseInt(e.target.value, 10),
                )
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {idleTimeoutOptions.map((o) => (
                <option key={o} value={o}>
                  {o}{" "}
                  {o === 1
                    ? i18n.t(
                        "policies:configurationPolicies.featureTabs.remoteAccessTab.minute",
                      )
                    : i18n.t(
                        "policies:configurationPolicies.featureTabs.remoteAccessTab.minutes",
                      )}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-md border bg-background px-4 py-3">
            <label className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.maxSessionDurationHours",
              )}
            </label>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.forceDisconnectAfterThisDurationRegardlessOf",
              )}
            </p>
            <select
              value={settings.maxSessionDurationHours}
              onChange={(e) =>
                update(
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.remoteAccessTab.maxSessionDurationHours2",
                  ),
                  parseInt(e.target.value, 10),
                )
              }
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {maxSessionOptions.map((o) => (
                <option key={o} value={o}>
                  {o}{" "}
                  {o === 1
                    ? i18n.t(
                        "policies:configurationPolicies.featureTabs.remoteAccessTab.hour",
                      )
                    : i18n.t(
                        "policies:configurationPolicies.featureTabs.remoteAccessTab.hours",
                      )}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Network Proxy */}
      <div className="mt-6">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.networkProxy",
            )}
          </h3>
        </div>
        <div className="mt-3 space-y-3">
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.enableProxyThroughManagedDevices",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.allowTunnelingNetworkTrafficThroughEnrolledAgents",
            )}
            checked={settings.enableProxy}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.enableProxy",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.autoEnableProxyForDiscoveredDevices",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.automaticallyEnableProxyCapabilityWhenNewDevices",
            )}
            checked={settings.autoEnableProxy}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.remoteAccessTab.autoEnableProxy",
                ),
                v,
              )
            }
          />
        </div>

        {/* Allowed Ports */}
        <div className="mt-4">
          <h4 className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.defaultAllowedPorts",
            )}
          </h4>
          <p className="text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.remoteAccessTab.portsPermittedForProxyTunnelingEnterA",
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={newPort}
              onChange={(e) => setNewPort(e.target.value)}
              onKeyDown={(e) =>
                e.key ===
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.remoteAccessTab.enter",
                  ) && (e.preventDefault(), handleAddPort())
              }
              placeholder={i18n.t(
                "policies:configurationPolicies.featureTabs.remoteAccessTab.addPort",
              )}
              type="number"
              min={1}
              max={65535}
              className="h-10 w-32 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={handleAddPort}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              {i18n.t("common:actions.add")}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {settings.defaultAllowedPorts.map((port) => (
              <span
                key={port}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-3 py-1.5 text-sm font-medium"
              >
                {port}
                <button
                  type="button"
                  onClick={() => handleRemovePort(port)}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
    </FeatureTabShell>
  );
}
