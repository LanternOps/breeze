package security

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// ErrNotSupported is returned when platform-specific operations are unavailable.
var ErrNotSupported = errors.New("operation not supported on this platform")

// AVProduct represents an antivirus product detected on the endpoint.
type AVProduct struct {
	DisplayName          string `json:"displayName"`
	Provider             string `json:"provider"`
	ProductState         int    `json:"productState"`
	ProductStateHex      string `json:"productStateHex"`
	Registered           bool   `json:"registered"`
	RealTimeProtection   bool   `json:"realTimeProtection"`
	DefinitionsUpToDate  bool   `json:"definitionsUpToDate"`
	PathToSignedProduct  string `json:"pathToSignedProductExe,omitempty"`
	PathToSignedReporter string `json:"pathToSignedReportingExe,omitempty"`
	Timestamp            string `json:"timestamp,omitempty"`
	InstanceGUID         string `json:"instanceGuid,omitempty"`
}

// SecurityStatus is the agent payload for endpoint security posture.
type SecurityStatus struct {
	DeviceID                       string      `json:"deviceId"`
	DeviceName                     string      `json:"deviceName"`
	OrgID                          string      `json:"orgId"`
	OS                             string      `json:"os"`
	Provider                       string      `json:"provider"`
	ProviderVersion                string      `json:"providerVersion,omitempty"`
	DefinitionsVersion             string      `json:"definitionsVersion,omitempty"`
	DefinitionsUpdatedAt           string      `json:"definitionsDate,omitempty"`
	LastScanAt                     string      `json:"lastScan,omitempty"`
	LastScanType                   string      `json:"lastScanType,omitempty"`
	RealTimeProtection             bool        `json:"realTimeProtection"`
	ThreatCount                    int         `json:"threatCount"`
	FirewallEnabled                bool        `json:"firewallEnabled"`
	EncryptionStatus               string      `json:"encryptionStatus"`
	EncryptionDetails              any         `json:"encryptionDetails,omitempty"`
	LocalAdminSummary              any         `json:"localAdminSummary,omitempty"`
	PasswordPolicySummary          any         `json:"passwordPolicySummary,omitempty"`
	GatekeeperEnabled              *bool       `json:"gatekeeperEnabled,omitempty"`
	GuardianEnabled                *bool       `json:"guardianEnabled,omitempty"`
	WindowsSecurityCenterAvailable bool        `json:"windowsSecurityCenterAvailable,omitempty"`
	AVProducts                     []AVProduct `json:"avProducts,omitempty"`
}

// DefenderStatus captures Microsoft Defender health details.
type DefenderStatus struct {
	Enabled              bool
	RealTimeProtection   bool
	ProviderVersion      string
	DefinitionsVersion   string
	DefinitionsUpdatedAt string
	LastQuickScan        string
	LastFullScan         string
}

func normalizeOS(goos string) string {
	switch goos {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	case "linux":
		return "linux"
	default:
		return goos
	}
}

func defaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		programData := os.Getenv("ProgramData")
		if programData == "" {
			return filepath.Join("C:", "ProgramData", "Breeze")
		}
		return filepath.Join(programData, "Breeze")
	case "darwin":
		return "/Library/Application Support/Breeze"
	default:
		return "/var/lib/breeze"
	}
}

func providerFromName(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.Contains(lower, "defender"):
		return "windows_defender"
	case strings.Contains(lower, "bitdefender"):
		return "bitdefender"
	case strings.Contains(lower, "sophos"):
		return "sophos"
	case strings.Contains(lower, "sentinel"):
		return "sentinelone"
	case strings.Contains(lower, "crowdstrike"):
		return "crowdstrike"
	case strings.Contains(lower, "malwarebytes"):
		return "malwarebytes"
	case strings.Contains(lower, "eset"):
		return "eset"
	case strings.Contains(lower, "kaspersky"):
		return "kaspersky"
	default:
		return "other"
	}
}

func latestScanTime(defenderStatus DefenderStatus) string {
	if defenderStatus.LastFullScan != "" {
		return defenderStatus.LastFullScan
	}
	return defenderStatus.LastQuickScan
}

func encryptionString(enabled bool, detectErr error) string {
	if detectErr != nil {
		return "unknown"
	}
	if enabled {
		return "encrypted"
	}
	return "unencrypted"
}

func boolPtr(value bool) *bool {
	return &value
}

func resolveExecutable(name string) (string, bool) {
	path, err := exec.LookPath(name)
	return path, err == nil
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func findMacDefenderAppPath() string {
	candidates := []string{
		"/Applications/Microsoft Defender.app",
		"/Applications/Microsoft Defender ATP.app",
	}

	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate
		}
	}

	return ""
}

func readMacAppVersion(appPath string) string {
	if appPath == "" {
		return ""
	}
	infoPath := filepath.Join(appPath, "Contents", "Info")
	output, err := runCommand(4*time.Second, "defaults", "read", infoPath, "CFBundleShortVersionString")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func normalizeTimestampString(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}

	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05 -0700 MST",
		"1/2/2006 3:04:05 PM",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Format(time.RFC3339)
		}
	}

	return value
}

func lookupValue(payload map[string]any, key string) (any, bool) {
	parts := strings.Split(key, ".")
	var current any = payload

	for _, part := range parts {
		record, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		next, ok := record[part]
		if !ok {
			return nil, false
		}
		current = next
	}

	return current, true
}

func boolFromAny(value any) (bool, bool) {
	switch v := value.(type) {
	case bool:
		return v, true
	case float64:
		return v != 0, true
	case int:
		return v != 0, true
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on", "enabled":
			return true, true
		case "0", "false", "no", "off", "disabled":
			return false, true
		}
	}
	return false, false
}

func intFromAny(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func stringFromAny(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed != "" {
			return trimmed, true
		}
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case int:
		return strconv.Itoa(v), true
	case int64:
		return strconv.FormatInt(v, 10), true
	}
	return "", false
}

func lookupString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		raw, ok := lookupValue(payload, key)
		if !ok {
			continue
		}
		if value, ok := stringFromAny(raw); ok {
			return value
		}
	}
	return ""
}

func lookupBool(payload map[string]any, keys ...string) (bool, bool) {
	for _, key := range keys {
		raw, ok := lookupValue(payload, key)
		if !ok {
			continue
		}
		if value, ok := boolFromAny(raw); ok {
			return value, true
		}
	}
	return false, false
}

func lookupInt(payload map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		raw, ok := lookupValue(payload, key)
		if !ok {
			continue
		}
		if value, ok := intFromAny(raw); ok {
			return value, true
		}
	}
	return 0, false
}

func parseMacDefenderHealth(output string) (DefenderStatus, AVProduct, error) {
	output = strings.TrimSpace(output)
	if output == "" {
		return DefenderStatus{}, AVProduct{}, fmt.Errorf("empty mdatp health output")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		return DefenderStatus{}, AVProduct{}, fmt.Errorf("failed to parse mdatp health output: %w", err)
	}

	status := DefenderStatus{
		Enabled:            true,
		ProviderVersion:    lookupString(payload, "app_version", "product_version", "version"),
		DefinitionsVersion: lookupString(payload, "definitions_version", "virus_definitions_version", "security_intelligence_version"),
		LastQuickScan:      normalizeTimestampString(lookupString(payload, "last_quick_scan", "scan.last_quick_scan")),
		LastFullScan:       normalizeTimestampString(lookupString(payload, "last_full_scan", "scan.last_full_scan")),
	}

	if realTime, ok := lookupBool(payload, "real_time_protection_enabled", "realTimeProtectionEnabled", "real_time_protection_available"); ok {
		status.RealTimeProtection = realTime
	}

	status.DefinitionsUpdatedAt = normalizeTimestampString(lookupString(
		payload,
		"definitions_updated_at",
		"definitions_updated",
		"security_intelligence_updated_at",
	))
	if status.DefinitionsUpdatedAt == "" {
		if minutes, ok := lookupInt(payload, "definitions_updated_minutes_ago"); ok && minutes >= 0 {
			status.DefinitionsUpdatedAt = time.Now().UTC().Add(-time.Duration(minutes) * time.Minute).Format(time.RFC3339)
		}
	}

	definitionsUpToDate := false
	if value, ok := lookupBool(payload, "definitions_up_to_date", "security_intelligence_up_to_date"); ok {
		definitionsUpToDate = value
	} else {
		state := strings.ToLower(lookupString(payload, "definitions_status", "security_intelligence_status"))
		if strings.Contains(state, "up_to_date") || strings.Contains(state, "ok") || strings.Contains(state, "current") {
			definitionsUpToDate = true
		}
	}
	if !definitionsUpToDate {
		if minutes, ok := lookupInt(payload, "definitions_updated_minutes_ago"); ok && minutes >= 0 {
			definitionsUpToDate = minutes <= 24*60
		}
	}

	displayName := lookupString(payload, "product_name", "display_name", "app_name")
	if displayName == "" {
		displayName = "Microsoft Defender for Endpoint"
	}

	product := AVProduct{
		DisplayName:         displayName,
		Provider:            "windows_defender",
		Registered:          true,
		RealTimeProtection:  status.RealTimeProtection,
		DefinitionsUpToDate: definitionsUpToDate,
		Timestamp:           status.DefinitionsUpdatedAt,
	}

	return status, product, nil
}

func getMacDefenderStatus() (DefenderStatus, *AVProduct, error) {
	if runtime.GOOS != "darwin" {
		return DefenderStatus{}, nil, ErrNotSupported
	}

	mdatpPath, hasMdatp := resolveExecutable("mdatp")
	appPath := findMacDefenderAppPath()
	if !hasMdatp && appPath == "" {
		return DefenderStatus{}, nil, ErrNotSupported
	}

	if hasMdatp {
		healthOutput, healthErr := runCommand(10*time.Second, mdatpPath, "health", "--output", "json")
		if healthErr == nil {
			status, product, parseErr := parseMacDefenderHealth(healthOutput)
			if parseErr == nil {
				if status.ProviderVersion == "" {
					versionOutput, versionErr := runCommand(5*time.Second, mdatpPath, "version")
					if versionErr == nil {
						status.ProviderVersion = strings.TrimSpace(strings.Split(versionOutput, "\n")[0])
					}
				}
				if status.ProviderVersion == "" {
					status.ProviderVersion = readMacAppVersion(appPath)
				}
				return status, &product, nil
			}
			healthErr = parseErr
		}

		if appPath == "" {
			return DefenderStatus{}, nil, healthErr
		}
	}

	status := DefenderStatus{
		Enabled:         true,
		ProviderVersion: readMacAppVersion(appPath),
	}

	product := AVProduct{
		DisplayName:         "Microsoft Defender for Endpoint",
		Provider:            "windows_defender",
		Registered:          true,
		RealTimeProtection:  false,
		DefinitionsUpToDate: false,
		PathToSignedProduct: filepath.Join(appPath, "Contents", "MacOS", "Microsoft Defender"),
	}

	return status, &product, nil
}

func getGatekeeperStatusDarwin() (bool, error) {
	if runtime.GOOS != "darwin" {
		return false, ErrNotSupported
	}

	output, err := runCommand(6*time.Second, "spctl", "--status")
	if err != nil {
		return false, err
	}

	lower := strings.ToLower(output)
	if strings.Contains(lower, "enabled") {
		return true, nil
	}
	if strings.Contains(lower, "disabled") {
		return false, nil
	}

	return false, fmt.Errorf("unexpected gatekeeper status output: %s", strings.TrimSpace(output))
}

func parseJSONValue(output string) (any, error) {
	var value any
	if err := json.Unmarshal([]byte(output), &value); err != nil {
		return nil, err
	}
	return value, nil
}

func toObjectSlice(value any) []map[string]any {
	switch typed := value.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			record, ok := item.(map[string]any)
			if ok {
				out = append(out, record)
			}
		}
		return out
	case map[string]any:
		return []map[string]any{typed}
	default:
		return nil
	}
}

func floatFromAny(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func collectEncryptionDetailsWindows() (map[string]any, error) {
	output, err := runCommand(
		10*time.Second,
		"powershell",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Get-BitLockerVolume | Select-Object MountPoint,ProtectionStatus,EncryptionMethod,VolumeStatus,EncryptionPercentage | ConvertTo-Json -Compress",
	)
	if err != nil {
		return nil, err
	}
	parsed, err := parseJSONValue(output)
	if err != nil {
		return nil, err
	}

	rawVolumes := toObjectSlice(parsed)
	volumes := make([]map[string]any, 0, len(rawVolumes))
	for _, item := range rawVolumes {
		mountPoint, _ := stringFromAny(item["MountPoint"])
		method, _ := stringFromAny(item["EncryptionMethod"])
		if method == "" {
			method = "bitlocker"
		}
		volumeStatus, _ := stringFromAny(item["VolumeStatus"])

		protected := false
		if value, ok := boolFromAny(item["ProtectionStatus"]); ok {
			protected = value
		} else if value, ok := stringFromAny(item["ProtectionStatus"]); ok {
			normalized := strings.ToLower(strings.TrimSpace(value))
			protected = normalized == "on" || normalized == "protected" || normalized == "1"
		}

		entry := map[string]any{
			"mount":     mountPoint,
			"method":    strings.ToLower(method),
			"protected": protected,
			"status":    volumeStatus,
		}
		if percent, ok := floatFromAny(item["EncryptionPercentage"]); ok {
			entry["percentEncrypted"] = percent
		}
		volumes = append(volumes, entry)
	}

	return map[string]any{
		"source":  "bitlocker",
		"volumes": volumes,
	}, nil
}

func collectEncryptionDetailsDarwin() (map[string]any, error) {
	output, err := runCommand(6*time.Second, "fdesetup", "status")
	if err != nil {
		return nil, err
	}
	lower := strings.ToLower(output)
	protected := strings.Contains(lower, "filevault is on")
	return map[string]any{
		"source": "filevault",
		"volumes": []map[string]any{
			{
				"mount":     "/",
				"method":    "filevault",
				"protected": protected,
				"status":    strings.TrimSpace(output),
			},
		},
	}, nil
}

func collectEncryptionDetailsLinux() (map[string]any, error) {
	type lsblkNode struct {
		Name       string      `json:"name"`
		Type       string      `json:"type"`
		Mountpoint string      `json:"mountpoint"`
		Fstype     string      `json:"fstype"`
		Children   []lsblkNode `json:"children"`
	}
	type lsblkPayload struct {
		Blockdevices []lsblkNode `json:"blockdevices"`
	}

	output, err := runCommand(8*time.Second, "lsblk", "-J", "-o", "NAME,TYPE,MOUNTPOINT,FSTYPE")
	if err != nil {
		return nil, err
	}

	var payload lsblkPayload
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		return nil, err
	}

	volumes := make([]map[string]any, 0)
	var walk func(node lsblkNode, inheritedProtected bool)
	walk = func(node lsblkNode, inheritedProtected bool) {
		isProtected := inheritedProtected ||
			strings.EqualFold(node.Type, "crypt") ||
			strings.Contains(strings.ToLower(node.Fstype), "luks")

		if strings.TrimSpace(node.Mountpoint) != "" {
			method := "none"
			if isProtected {
				method = "luks"
			}
			volumes = append(volumes, map[string]any{
				"mount":     node.Mountpoint,
				"device":    node.Name,
				"method":    method,
				"protected": isProtected,
			})
		}

		for _, child := range node.Children {
			walk(child, isProtected)
		}
	}

	for _, node := range payload.Blockdevices {
		walk(node, false)
	}

	return map[string]any{
		"source":  "lsblk",
		"volumes": volumes,
	}, nil
}

func collectEncryptionDetails() (map[string]any, error) {
	switch runtime.GOOS {
	case "windows":
		return collectEncryptionDetailsWindows()
	case "darwin":
		return collectEncryptionDetailsDarwin()
	case "linux":
		return collectEncryptionDetailsLinux()
	default:
		return nil, ErrNotSupported
	}
}

func collectLocalAdminSummaryWindows() (map[string]any, error) {
	output, err := runCommand(
		10*time.Second,
		"powershell",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Get-LocalGroupMember -Group 'Administrators' | Select-Object Name,ObjectClass,SID,PrincipalSource | ConvertTo-Json -Compress",
	)
	if err != nil {
		return nil, err
	}

	parsed, err := parseJSONValue(output)
	if err != nil {
		return nil, err
	}

	members := toObjectSlice(parsed)
	accounts := make([]map[string]any, 0, len(members))
	for _, member := range members {
		username, _ := stringFromAny(member["Name"])
		if username == "" {
			continue
		}
		sid, _ := stringFromAny(member["SID"])
		isBuiltIn := strings.HasSuffix(strings.TrimSpace(sid), "-500") ||
			strings.EqualFold(username, "Administrator")
		entry := map[string]any{
			"username":   username,
			"isBuiltIn":  isBuiltIn,
			"enabled":    true,
			"objectType": member["ObjectClass"],
		}
		if isBuiltIn {
			entry["defaultAccount"] = true
		}
		accounts = append(accounts, entry)
	}

	return map[string]any{
		"source":            "windows_local_group",
		"adminCount":        len(accounts),
		"localAccountCount": len(accounts),
		"accounts":          accounts,
	}, nil
}

func collectLocalAdminSummaryDarwin() (map[string]any, error) {
	output, err := runCommand(6*time.Second, "dscl", ".", "-read", "/Groups/admin", "GroupMembership")
	if err != nil {
		return nil, err
	}

	parts := strings.SplitN(strings.TrimSpace(output), ":", 2)
	if len(parts) < 2 {
		return map[string]any{
			"source":            "dscl_admin_group",
			"adminCount":        0,
			"localAccountCount": 0,
			"accounts":          []map[string]any{},
		}, nil
	}

	usernames := strings.Fields(strings.TrimSpace(parts[1]))
	accounts := make([]map[string]any, 0, len(usernames))
	for _, username := range usernames {
		accounts = append(accounts, map[string]any{
			"username":  username,
			"isBuiltIn": username == "root",
			"enabled":   true,
		})
	}

	return map[string]any{
		"source":            "dscl_admin_group",
		"adminCount":        len(accounts),
		"localAccountCount": len(accounts),
		"accounts":          accounts,
	}, nil
}

func parseGroupMembers(output string) []string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, ":")
	if len(parts) < 4 {
		return nil
	}
	memberField := strings.TrimSpace(parts[3])
	if memberField == "" {
		return nil
	}
	rawMembers := strings.Split(memberField, ",")
	members := make([]string, 0, len(rawMembers))
	for _, member := range rawMembers {
		name := strings.TrimSpace(member)
		if name == "" {
			continue
		}
		members = append(members, name)
	}
	return members
}

func collectLocalAdminSummaryLinux() (map[string]any, error) {
	members := []string{}
	if output, err := runCommand(5*time.Second, "getent", "group", "sudo"); err == nil {
		members = parseGroupMembers(output)
	}
	if len(members) == 0 {
		if output, err := runCommand(5*time.Second, "getent", "group", "wheel"); err == nil {
			members = parseGroupMembers(output)
		}
	}

	accounts := make([]map[string]any, 0, len(members))
	for _, username := range members {
		accounts = append(accounts, map[string]any{
			"username":  username,
			"isBuiltIn": username == "root",
			"enabled":   true,
		})
	}

	return map[string]any{
		"source":            "getent_admin_group",
		"adminCount":        len(accounts),
		"localAccountCount": len(accounts),
		"accounts":          accounts,
	}, nil
}

func collectLocalAdminSummary() (map[string]any, error) {
	switch runtime.GOOS {
	case "windows":
		return collectLocalAdminSummaryWindows()
	case "darwin":
		return collectLocalAdminSummaryDarwin()
	case "linux":
		return collectLocalAdminSummaryLinux()
	default:
		return nil, ErrNotSupported
	}
}

func collectPasswordPolicySummaryWindows() (map[string]any, error) {
	output, err := runCommand(
		10*time.Second,
		"powershell",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$p=Get-CimInstance -ClassName Win32_AccountPolicy; [pscustomobject]@{minLength=[int]$p.MinPasswordLength;maxAgeDays=[int]$p.MaxPasswordAge.TotalDays;lockoutThreshold=[int]$p.LockoutThreshold;historyCount=[int]$p.PasswordHistorySize} | ConvertTo-Json -Compress",
	)
	if err != nil {
		return nil, err
	}

	parsed, err := parseJSONValue(output)
	if err != nil {
		return nil, err
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("unexpected windows password policy payload")
	}
	record["source"] = "win32_account_policy"
	return record, nil
}

func parsePwPolicyDarwin(output string) map[string]any {
	result := map[string]any{
		"source": "pwpolicy",
	}
	tokens := strings.Fields(output)
	parsed := map[string]string{}
	for _, token := range tokens {
		parts := strings.SplitN(token, "=", 2)
		if len(parts) != 2 {
			continue
		}
		parsed[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}

	if value, ok := parsed["minChars"]; ok {
		if n, err := strconv.Atoi(value); err == nil {
			result["minLength"] = n
		}
	}
	requiresAlpha := parsed["requiresAlpha"] == "1"
	requiresNumeric := parsed["requiresNumeric"] == "1"
	if _, hasAlpha := parsed["requiresAlpha"]; hasAlpha {
		result["complexityEnabled"] = requiresAlpha && requiresNumeric
	}
	if value, ok := parsed["maxMinutesUntilChangePassword"]; ok {
		if n, err := strconv.Atoi(value); err == nil && n > 0 {
			result["maxAgeDays"] = int(float64(n) / 1440.0)
		}
	}
	if value, ok := parsed["maxFailedLoginAttempts"]; ok {
		if n, err := strconv.Atoi(value); err == nil {
			result["lockoutThreshold"] = n
		}
	}
	if value, ok := parsed["usingHistory"]; ok {
		if n, err := strconv.Atoi(value); err == nil {
			result["historyCount"] = n
		}
	}

	return result
}

func collectPasswordPolicySummaryDarwin() (map[string]any, error) {
	output, err := runCommand(6*time.Second, "pwpolicy", "-getglobalpolicy")
	if err != nil {
		return nil, err
	}
	return parsePwPolicyDarwin(output), nil
}

func parseLoginDefsPolicy(content string) map[string]any {
	result := map[string]any{
		"source": "login.defs",
	}
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) < 2 {
			continue
		}
		key := strings.ToUpper(fields[0])
		value := fields[1]
		switch key {
		case "PASS_MIN_LEN":
			if n, err := strconv.Atoi(value); err == nil {
				result["minLength"] = n
			}
		case "PASS_MAX_DAYS":
			if n, err := strconv.Atoi(value); err == nil {
				result["maxAgeDays"] = n
			}
		}
	}
	return result
}

func collectPasswordPolicySummaryLinux() (map[string]any, error) {
	result := map[string]any{
		"source": "linux_password_policy",
	}

	if content, err := os.ReadFile("/etc/login.defs"); err == nil {
		for key, value := range parseLoginDefsPolicy(string(content)) {
			result[key] = value
		}
	}

	pamCandidates := []string{
		"/etc/pam.d/common-password",
		"/etc/pam.d/system-auth",
		"/etc/pam.d/password-auth",
	}
	for _, path := range pamCandidates {
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lower := strings.ToLower(string(content))
		if strings.Contains(lower, "pam_pwquality") || strings.Contains(lower, "pam_cracklib") {
			result["complexityEnabled"] = true
			break
		}
	}

	if content, err := os.ReadFile("/etc/security/faillock.conf"); err == nil {
		for _, line := range strings.Split(string(content), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if strings.HasPrefix(trimmed, "deny") {
				parts := strings.SplitN(trimmed, "=", 2)
				if len(parts) == 2 {
					if n, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil {
						result["lockoutThreshold"] = n
						break
					}
				}
			}
		}
	}

	return result, nil
}

func collectPasswordPolicySummary() (map[string]any, error) {
	switch runtime.GOOS {
	case "windows":
		return collectPasswordPolicySummaryWindows()
	case "darwin":
		return collectPasswordPolicySummaryDarwin()
	case "linux":
		return collectPasswordPolicySummaryLinux()
	default:
		return nil, ErrNotSupported
	}
}

// CollectStatus gathers AV/firewall/encryption posture for this endpoint.
func CollectStatus(cfg *config.Config) (SecurityStatus, error) {
	var status SecurityStatus
	var errs []error

	if cfg == nil {
		cfg = config.Default()
	}

	hostname, hostErr := os.Hostname()
	if hostErr != nil {
		errs = append(errs, hostErr)
	}

	status.DeviceID = cfg.AgentID
	status.OrgID = cfg.OrgID
	status.DeviceName = hostname
	status.OS = normalizeOS(runtime.GOOS)
	status.Provider = "other"
	status.EncryptionStatus = "unknown"

	// Windows Security Center AV products (workstations) first.
	if runtime.GOOS == "windows" {
		products, wscErr := GetWindowsSecurityCenterProducts()
		if wscErr != nil {
			if !errors.Is(wscErr, ErrNotSupported) {
				errs = append(errs, wscErr)
			}
		} else {
			status.WindowsSecurityCenterAvailable = true
			status.AVProducts = products
			if len(products) > 0 {
				primary := products[0]
				for _, candidate := range products {
					if candidate.RealTimeProtection {
						primary = candidate
						break
					}
				}
				status.Provider = primary.Provider
				status.RealTimeProtection = primary.RealTimeProtection
				status.DefinitionsUpdatedAt = primary.Timestamp
			}
		}
	}

	// Defender on macOS (Microsoft Defender for Endpoint via mdatp).
	if runtime.GOOS == "darwin" {
		macDefenderStatus, macDefenderProduct, macDefenderErr := getMacDefenderStatus()
		if macDefenderErr != nil {
			if !errors.Is(macDefenderErr, ErrNotSupported) {
				errs = append(errs, macDefenderErr)
			}
		} else {
			if status.Provider == "other" && macDefenderStatus.Enabled {
				status.Provider = "windows_defender"
			}
			if macDefenderProduct != nil {
				status.AVProducts = append(status.AVProducts, *macDefenderProduct)
			}
			if status.ProviderVersion == "" {
				status.ProviderVersion = macDefenderStatus.ProviderVersion
			}
			if macDefenderStatus.RealTimeProtection {
				status.RealTimeProtection = true
			}
			if status.DefinitionsVersion == "" {
				status.DefinitionsVersion = macDefenderStatus.DefinitionsVersion
			}
			if status.DefinitionsUpdatedAt == "" {
				status.DefinitionsUpdatedAt = macDefenderStatus.DefinitionsUpdatedAt
			}
			status.LastScanAt = latestScanTime(macDefenderStatus)
			if macDefenderStatus.LastFullScan != "" {
				status.LastScanType = "full"
			} else if macDefenderStatus.LastQuickScan != "" {
				status.LastScanType = "quick"
			}
		}
	}

	// Defender fallback (Windows Server and environments where WSC data is unavailable).
	defenderStatus, defErr := GetDefenderStatus()
	if defErr != nil {
		if !errors.Is(defErr, ErrNotSupported) {
			errs = append(errs, defErr)
		}
	} else {
		if status.Provider == "other" {
			status.Provider = "windows_defender"
		}
		if status.ProviderVersion == "" {
			status.ProviderVersion = defenderStatus.ProviderVersion
		}
		if defenderStatus.RealTimeProtection {
			status.RealTimeProtection = true
		}
		if status.DefinitionsVersion == "" {
			status.DefinitionsVersion = defenderStatus.DefinitionsVersion
		}
		if status.DefinitionsUpdatedAt == "" {
			status.DefinitionsUpdatedAt = defenderStatus.DefinitionsUpdatedAt
		}
		status.LastScanAt = latestScanTime(defenderStatus)
		if defenderStatus.LastFullScan != "" {
			status.LastScanType = "full"
		} else if defenderStatus.LastQuickScan != "" {
			status.LastScanType = "quick"
		}
	}

	firewallEnabled, fwErr := GetFirewallStatus()
	if fwErr != nil {
		errs = append(errs, fwErr)
	}
	status.FirewallEnabled = firewallEnabled

	encryptionEnabled, encErr := getEncryptionStatus()
	if encErr != nil {
		errs = append(errs, encErr)
	}
	status.EncryptionStatus = encryptionString(encryptionEnabled, encErr)
	if details, err := collectEncryptionDetails(); err == nil {
		status.EncryptionDetails = details
	}

	if localAdmins, err := collectLocalAdminSummary(); err == nil {
		status.LocalAdminSummary = localAdmins
	}

	if passwordPolicy, err := collectPasswordPolicySummary(); err == nil {
		status.PasswordPolicySummary = passwordPolicy
	}

	if runtime.GOOS == "darwin" {
		gatekeeperEnabled, gatekeeperErr := getGatekeeperStatusDarwin()
		if gatekeeperErr != nil {
			errs = append(errs, gatekeeperErr)
		} else {
			status.GatekeeperEnabled = boolPtr(gatekeeperEnabled)
			status.GuardianEnabled = boolPtr(gatekeeperEnabled)
		}
	}

	return status, errors.Join(errs...)
}

// GetFirewallStatus returns whether a firewall is enabled on the host.
func GetFirewallStatus() (bool, error) {
	switch runtime.GOOS {
	case "windows":
		return getFirewallStatusWindows()
	case "darwin":
		return getFirewallStatusDarwin()
	default:
		return getFirewallStatusLinux()
	}
}

func getFirewallStatusWindows() (bool, error) {
	output, err := runCommand(8*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-NetFirewallProfile | Select-Object -ExpandProperty Enabled")
	if err != nil {
		return false, err
	}

	for _, line := range strings.Split(output, "\n") {
		if strings.EqualFold(strings.TrimSpace(line), "True") {
			return true, nil
		}
	}

	return false, nil
}

func getFirewallStatusDarwin() (bool, error) {
	output, err := runCommand(5*time.Second, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate")
	if err == nil {
		lower := strings.ToLower(output)
		if strings.Contains(lower, "enabled") {
			return true, nil
		}
		if strings.Contains(lower, "disabled") {
			return false, nil
		}
	}

	output, err = runCommand(5*time.Second, "defaults", "read", "/Library/Preferences/com.apple.alf", "globalstate")
	if err != nil {
		return false, err
	}

	state := strings.TrimSpace(output)
	switch state {
	case "1", "2":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, fmt.Errorf("unexpected firewall state: %s", state)
	}
}

func getFirewallStatusLinux() (bool, error) {
	if hasCommand("ufw") {
		output, err := runCommand(5*time.Second, "ufw", "status")
		if err == nil {
			if strings.Contains(output, "Status: active") {
				return true, nil
			}
			if strings.Contains(output, "Status: inactive") {
				return false, nil
			}
		}
	}

	if hasCommand("firewall-cmd") {
		output, err := runCommand(5*time.Second, "firewall-cmd", "--state")
		if err == nil {
			state := strings.TrimSpace(output)
			if state == "running" {
				return true, nil
			}
			if state == "not running" {
				return false, nil
			}
		}
	}

	if hasCommand("systemctl") {
		output, err := runCommand(5*time.Second, "systemctl", "is-active", "firewalld")
		if err == nil {
			state := strings.TrimSpace(output)
			if state == "active" {
				return true, nil
			}
			if state == "inactive" || state == "failed" {
				return false, nil
			}
		}
	}

	return false, fmt.Errorf("unable to determine firewall status")
}

func getEncryptionStatus() (bool, error) {
	switch runtime.GOOS {
	case "windows":
		return getEncryptionStatusWindows()
	case "darwin":
		return getEncryptionStatusDarwin()
	default:
		return getEncryptionStatusLinux()
	}
}

func getEncryptionStatusWindows() (bool, error) {
	output, err := runCommand(8*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-BitLockerVolume -MountPoint $env:SystemDrive | Select-Object -ExpandProperty ProtectionStatus")
	if err != nil {
		return false, err
	}

	return parseBitLockerProtectionStatus(output)
}

func parseBitLockerProtectionStatus(rawState string) (bool, error) {
	state := strings.ToLower(strings.TrimSpace(rawState))
	switch state {
	case "1", "on", "true", "enabled":
		return true, nil
	case "0", "off", "false", "disabled":
		return false, nil
	default:
		return false, fmt.Errorf("unexpected BitLocker status: %s", strings.TrimSpace(rawState))
	}
}

func getEncryptionStatusDarwin() (bool, error) {
	output, err := runCommand(5*time.Second, "fdesetup", "status")
	if err != nil {
		return false, err
	}

	lower := strings.ToLower(output)
	if strings.Contains(lower, "filevault is on") {
		return true, nil
	}
	if strings.Contains(lower, "filevault is off") {
		return false, nil
	}
	return false, fmt.Errorf("unexpected FileVault status: %s", strings.TrimSpace(output))
}

func getEncryptionStatusLinux() (bool, error) {
	if !hasCommand("lsblk") {
		return false, fmt.Errorf("lsblk not found")
	}

	output, err := runCommand(5*time.Second, "lsblk", "-o", "TYPE,MOUNTPOINT", "-nr")
	if err != nil {
		return false, err
	}

	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[0] == "crypt" && fields[1] == "/" {
			return true, nil
		}
	}

	return false, nil
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func runCommand(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("command timed out: %s", name)
	}
	if err != nil {
		return "", fmt.Errorf("command failed: %s: %w", name, err)
	}
	return strings.TrimSpace(string(output)), nil
}
