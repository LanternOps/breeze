// The platform-independent types and decision logic live here so they can be
// unit-tested on any OS; the registry I/O is in onedrivehelper_windows.go, with
// a no-op stub for other platforms in onedrivehelper_stub.go.
// (Same layout rationale as internal/winupdate.)
package onedrivehelper

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// BaseConfig mirrors the server's onedrive_helper_settings.base object
// (apps/api/src/routes/agents/helpers.ts OnedriveConfigUpdate).
type BaseConfig struct {
	SilentAccountConfig bool     `json:"silentAccountConfig"`
	FilesOnDemand       bool     `json:"filesOnDemand"`
	KfmSilentOptIn      bool     `json:"kfmSilentOptIn"`
	KfmFolders          []string `json:"kfmFolders"`
	KfmBlockOptOut      bool     `json:"kfmBlockOptOut"`
	TenantAssociationID string   `json:"tenantAssociationId"`
	RestartOnChange     bool     `json:"restartOnChange"`
}

// LibraryRule mirrors one entry of onedrive_helper_settings.libraries.
type LibraryRule struct {
	LibraryID     string `json:"libraryId"`
	DisplayName   string `json:"displayName"`
	SiteURL       string `json:"siteUrl"`
	TargetingMode string `json:"targetingMode"`
	GroupID       string `json:"groupId"`
	GroupName     string `json:"groupName"`
	HiveScope     string `json:"hiveScope"`
}

type Config struct {
	Base      BaseConfig    `json:"base"`
	Libraries []LibraryRule `json:"libraries"`
}

// DriftEntry records an applied library that OneDrive did not actually mount
// (e.g. the user previously "stopped sync" — AutoMount will not re-mount it).
type DriftEntry struct {
	LibraryID   string `json:"libraryId"`
	DisplayName string `json:"displayName"`
	Reason      string `json:"reason"`
}

// DeviceState is reported in the heartbeat payload as onedriveDeviceState and
// must match the zod schema in apps/api/src/routes/agents/heartbeat.ts.
type DeviceState struct {
	SignedIn          bool              `json:"signedIn"`
	OneDriveVersion   string            `json:"oneDriveVersion,omitempty"`
	FilesOnDemandOn   bool              `json:"filesOnDemandOn"`
	KfmFolderStates   map[string]string `json:"kfmFolderStates"`
	MountedLibraries  []string          `json:"mountedLibraries"`
	EntitledLibraries []string          `json:"entitledLibraries"`
	DriftEntries      []DriftEntry      `json:"driftEntries"`
}

// ParseConfig converts the untyped heartbeat configUpdate value into a Config
// via a JSON round-trip (same pattern as monitoring.ParseMonitorConfig).
// nulls from the wire (e.g. tenantAssociationId) become Go zero values.
func ParseConfig(raw any) (Config, bool) {
	var cfg Config
	if raw == nil {
		return cfg, false
	}
	if _, isObj := raw.(map[string]any); !isObj {
		return cfg, false
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return cfg, false
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, false
	}
	return cfg, true
}

// PartitionLibraries splits delivered rules into (apply, pending):
//   - everyone            → apply
//   - local_ad_group      → apply iff the user is a member of GroupName;
//     a miss (or empty GroupName) is simply not entitled.
//   - graph_group         → pending (server-side evaluation lands in Phase 4;
//     NEVER mount an unevaluated graph_group library)
//   - anything unknown    → pending (fail closed)
func PartitionLibraries(rules []LibraryRule, isLocalGroupMember func(groupName string) bool) (apply, pending []LibraryRule) {
	for _, r := range rules {
		switch r.TargetingMode {
		case "everyone":
			apply = append(apply, r)
		case "local_ad_group":
			if r.GroupName != "" && isLocalGroupMember != nil && isLocalGroupMember(r.GroupName) {
				apply = append(apply, r)
			}
		default: // graph_group + future modes
			pending = append(pending, r)
		}
	}
	return apply, pending
}

// ValueName derives the deterministic TenantAutoMount registry value name for a
// library. The name is cosmetic to OneDrive (it uses the library's own title),
// but the Breeze- prefix marks ownership and determinism makes writes idempotent.
func ValueName(libraryID string) string {
	sum := sha256.Sum256([]byte(libraryID))
	return "Breeze-" + hex.EncodeToString(sum[:6])
}

// TenantIDFromComposite extracts the tenantId=… field from an AutoMount
// composite; used as the KFMSilentOptIn tenant fallback when the policy has no
// explicit tenantAssociationId.
func TenantIDFromComposite(libraryID string) string {
	for _, part := range strings.Split(libraryID, "&") {
		if v, ok := strings.CutPrefix(part, "tenantId="); ok {
			return v
		}
	}
	return ""
}
