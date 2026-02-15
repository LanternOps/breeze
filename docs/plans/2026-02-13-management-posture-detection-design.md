# Management Posture Detection — Design Document

**Date:** 2026-02-13
**Branch:** `feat/management-tool-detection`
**Status:** Approved

## Purpose

Continuously detect what is **actively managing/controlling** each device — MDM enrollment, running RMM agents, applied policies, active security tools, identity join status, and more. This is a system-level compliance feature, distinct from software/application inventory.

**Key distinction:** Software inventory answers "what apps are installed?" Management posture answers "what is actively managing this device?"

## Scope

- **Platforms:** Windows + macOS at launch (Linux stubs for future)
- **Use case:** Compliance auditing — verify required management tools are present and active
- **Detection depth:** Full stack — services, processes, registry, enrollment profiles, config files, OS commands
- **Tool coverage:** ~60 tools across 11 categories at launch

## Data Model

### ManagementPosture (reported per device)

```go
type ManagementPosture struct {
    CollectedAt  time.Time              `json:"collectedAt"`
    ScanDuration time.Duration          `json:"scanDurationMs"`
    Categories   map[string][]Detection `json:"categories"`
    Identity     IdentityStatus         `json:"identity"`
    Errors       []string               `json:"errors,omitempty"`
}

type Detection struct {
    Name        string `json:"name"`                  // "ConnectWise Automate"
    Version     string `json:"version,omitempty"`
    Status      string `json:"status"`                // "active" | "installed" | "unknown"
    ServiceName string `json:"serviceName,omitempty"`
    Details     any    `json:"details,omitempty"`      // tool-specific metadata
}

type IdentityStatus struct {
    JoinType        string `json:"joinType"`            // "hybrid_azure_ad" | "azure_ad" | "on_prem_ad" | "workplace" | "none"
    AzureAdJoined   bool   `json:"azureAdJoined"`
    DomainJoined    bool   `json:"domainJoined"`
    WorkplaceJoined bool   `json:"workplaceJoined"`
    DomainName      string `json:"domainName,omitempty"`
    TenantId        string `json:"tenantId,omitempty"`
    MdmUrl          string `json:"mdmUrl,omitempty"`
    Source          string `json:"source"`              // "dsregcmd" | "dsconfigad" | "registry"
}
```

### Categories

| Key | Description |
|-----|-------------|
| `mdm` | Mobile Device Management enrollment |
| `rmm` | Remote Monitoring & Management agents |
| `remoteAccess` | Remote access/control tools |
| `endpointSecurity` | AV/EDR agents (augments existing SecurityStatus) |
| `policyEngine` | GPO, SCCM, config management (Chef/Puppet/Salt), macOS profiles |
| `backup` | Backup agents |
| `identityMfa` | Identity/MFA agents (Okta Verify, Duo Desktop, JumpCloud) |
| `siem` | Log forwarders (Splunk, Elastic, Wazuh) |
| `dnsFiltering` | DNS filtering / web security agents |
| `zeroTrustVpn` | Zero trust / VPN clients |
| `patchManagement` | Standalone patch management agents |

### Status Resolution

- `service_running` or `process_running` match -> `"active"`
- `file_exists` or `registry_value` only -> `"installed"`
- No match -> tool not listed

## Architecture: Composable Check Primitives

Instead of a custom scanner engine, management posture detection composes **existing agent primitives** into a check pipeline. No new system interaction code beyond two new shared primitives.

### Check Types

| CheckType | Maps To | Location |
|-----------|---------|----------|
| `file_exists` | `os.Stat()` | Existing (`security.fileExists`) |
| `registry_value` | `PolicyStateCollector.CollectRegistryState` | Existing (`collectors/policy_state_registry_windows.go`) |
| `config_value` | `PolicyStateCollector.CollectConfigState` | Existing (`collectors/policy_state.go`) |
| `command` | `runCommand` with timeout + output parsing | Existing (`security/status.go`) |
| `process_running` | Process snapshot match | New thin wrapper on `gopsutil/v3/process` |
| `service_running` | OS service status query | **New shared primitive** (`svcquery` package) |

### New Shared Primitive: `svcquery`

A general-purpose service query package — useful beyond management posture for health checks, compliance, troubleshooting, and AI tools.

```
agent/internal/svcquery/
├── svcquery.go            // Interface + types
├── svcquery_windows.go    // Windows svc/mgr API
├── svcquery_darwin.go     // launchctl list + plist scanning
├── svcquery_other.go      // Linux systemctl (stub/basic)
```

```go
type ServiceInfo struct {
    Name        string `json:"name"`
    DisplayName string `json:"displayName,omitempty"`
    Status      string `json:"status"`        // "running" | "stopped" | "disabled" | "unknown"
    StartType   string `json:"startType,omitempty"` // "automatic" | "manual" | "disabled"
    BinaryPath  string `json:"binaryPath,omitempty"`
}

func IsRunning(name string) (bool, error)
func GetStatus(name string) (ServiceInfo, error)
func ListServices() ([]ServiceInfo, error)
```

### Signature Format

```go
type Signature struct {
    Name     string   `json:"name"`      // "ConnectWise Automate"
    Category string   `json:"category"`  // "rmm"
    OS       []string `json:"os"`        // ["windows"], ["darwin"], or both
    Checks   []Check  `json:"checks"`    // evaluated in order, first match wins
    Version  *Check   `json:"version"`   // optional: how to get version after detection
}

type Check struct {
    Type  CheckType `json:"type"`
    Value string    `json:"value"`   // path, service name, process name, etc.
    Parse string    `json:"parse"`   // for command type: regex to extract value
    OS    string    `json:"os"`      // optional per-check OS override
}
```

**Example signature:**

```go
{
    Name: "ConnectWise Automate", Category: "rmm", OS: []string{"windows"},
    Checks: []Check{
        {Type: CheckServiceRunning, Value: "LTService"},
        {Type: CheckProcessRunning, Value: "LTSVC.exe"},
        {Type: CheckFileExists, Value: `C:\Windows\LTSvc\`},
    },
    Version: &Check{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\LabTech\Service`, Parse: "Version"},
}
```

**Evaluation:** Checks are ordered cheapest-first. First match wins (short-circuit). Service/process match -> `"active"`. File/registry match -> `"installed"`.

### Deep Detectors (Custom Parsing)

Two areas require structured command output parsing that doesn't fit the signature model:

**Identity detection:**
- Windows: `dsregcmd /status` -> parse AzureAdJoined, DomainJoined, WorkplaceJoined, DomainName, TenantId, MdmUrl
- macOS: `profiles status -type enrollment` -> MDM enrollment status; `dsconfigad -show` -> AD binding

**Policy enumeration:**
- Windows: Registry `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\History` -> count applied GPOs; `HKLM\SOFTWARE\Microsoft\CCM` -> SCCM presence
- macOS: `profiles list` -> enumerate installed configuration profiles with payload types

These use `runCommand()` underneath but need custom parsing functions.

### Package Structure

```
agent/internal/svcquery/          # New shared primitive
├── svcquery.go
├── svcquery_windows.go
├── svcquery_darwin.go
└── svcquery_other.go

agent/internal/mgmtdetect/        # Management posture detection
├── types.go                      # Detection, ManagementPosture, Signature, Check types
├── signatures.go                 # Built-in signature database (~60 tools, data only)
├── runner.go                     # Orchestrator: scan lifecycle, per-category timeout, assembly
├── checks.go                     # Dispatcher: maps CheckType -> primitive call
├── checks_windows.go             # Windows-specific check implementations
├── checks_darwin.go              # macOS-specific check implementations
├── checks_other.go               # Linux stub
├── process_snapshot.go           # Scan process list once, match many (wraps gopsutil)
├── deep_identity.go              # Shared identity types
├── deep_identity_windows.go      # dsregcmd parsing
├── deep_identity_darwin.go       # profiles status + dsconfigad parsing
├── deep_identity_other.go        # Stub
├── deep_policy.go                # Shared policy types
├── deep_policy_windows.go        # GPO count, SCCM detection
├── deep_policy_darwin.go         # macOS profile enumeration
├── deep_policy_other.go          # Stub
└── runner_test.go
```

## Robustness

- **Process snapshot:** `gopsutil.Processes()` called once per scan cycle. All `process_running` checks match against the cached list. O(signatures) not O(signatures * processes).
- **Per-category isolation:** Each category runs with its own timeout (5s default). If one category fails (e.g., `dsregcmd` hangs), all other categories still report.
- **Stable identifiers:** Signatures match on service names and binary paths, not display names. Handles white-labeled tools (Kaseya, ConnectWise, etc.).
- **Scan cadence:** Default every 15 minutes. Force-refresh available via API command. Not every heartbeat — this data changes rarely.
- **Graceful degradation:** Collect what succeeds, accumulate errors for what doesn't, never block the heartbeat loop.
- **No admin required:** Vast majority of checks work without elevation. Noted in research where admin is needed.

## Heartbeat Integration

- New `sendManagementPosture()` method on the Heartbeat struct
- Calls `mgmtdetect.CollectPosture()` on its own timer (15 min default, configurable via server config)
- Reports via existing `sendInventoryData("management/posture", posture, ...)` pattern
- Same pattern as security status, software inventory, connections

## API & Database

### Database

- New JSONB column `managementPosture` on the `devices` table
- Indexed for filtering: GIN index on `managementPosture->'categories'`

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/devices/:id` | Includes `managementPosture` in device detail |
| `GET` | `/api/v1/devices/:id/management-posture` | Detailed posture view with full detection metadata |
| `POST` | `/api/v1/agents/:id/commands` | `type: "refresh_management_posture"` for force-refresh |
| `GET` | `/api/v1/devices?managementTool=<name>` | Filter devices by detected tool |

## Tools Covered at Launch (~60)

| Category | Tools |
|----------|-------|
| **MDM** | Intune, JAMF, Mosyle, Kandji, Addigy, Hexnode, Fleet, Workspace ONE |
| **Identity/MFA** | Azure AD/Entra join, AD domain join, Okta Verify, Duo Desktop, JumpCloud |
| **RMM** | ConnectWise Automate, ScreenConnect, Datto, NinjaOne, Atera, SyncroMSP, N-able, Kaseya, Pulseway, Level, Tactical RMM |
| **Remote Access** | TeamViewer, AnyDesk, Splashtop, LogMeIn, BeyondTrust, GoTo Resolve, RustDesk, VNC variants |
| **Endpoint Security** | CrowdStrike, SentinelOne, Sophos, Bitdefender, Malwarebytes, Carbon Black, Huntress, Defender |
| **Policy Engine** | Group Policy, SCCM/MECM, Chef, Puppet, Salt, macOS config profiles |
| **Backup** | Veeam, Acronis, Datto BCDR, Axcient, Carbonite, CrashPlan |
| **SIEM** | Splunk Universal Forwarder, Elastic Agent, Wazuh |
| **DNS Filtering** | Cisco Umbrella, DNSFilter, Netskope |
| **Zero Trust/VPN** | Zscaler, Cloudflare WARP, Tailscale, Cisco AnyConnect, GlobalProtect, FortiClient |
| **Patch Mgmt** | Automox |

## Detection Signal Reference

Full detection signals per tool (registry paths, service names, process names, file paths, commands) are documented in the research phase and will be encoded directly into `signatures.go`.

## Design Decisions

1. **Composable primitives over custom engine** — Reuses existing `PolicyStateCollector`, `runCommand`, `fileExists`, `gopsutil`. Only two new primitives: `svcquery` (shared) and process snapshot (internal).
2. **System-level posture, not software inventory** — Focuses on active management state. Software inventory is a separate existing feature.
3. **Declarative signatures** — Adding new tools is a data change, not a code change. ~80% of tools are simple signature matches.
4. **Custom detectors only where needed** — `dsregcmd`, `profiles status`, `dsconfigad`, GPO enumeration require structured output parsing that doesn't fit the signature model.
5. **`svcquery` as shared primitive** — Service status querying is fundamental to any RMM. Built as a first-class shared package, not buried in detection code.
