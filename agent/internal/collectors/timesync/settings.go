package timesync

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

var fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func zoneSyntax(id string) bool {
	return utf8.ValidString(id) && utf8.RuneCountInString(id) <= 128 &&
		strings.TrimSpace(id) == id && id != "" && !strings.ContainsAny(id, "\\/\x00\r\n")
}
func ValidateSettings(s Settings) error {
	if !fingerprintPattern.MatchString(s.Fingerprint) {
		return fmt.Errorf("invalid fingerprint")
	}
	if s.PollIntervalMinutes < 15 || s.PollIntervalMinutes > 1440 {
		return fmt.Errorf("invalid poll interval")
	}
	if s.NTPServers == nil || len(s.NTPServers) > 5 || (s.EnforceNTP && len(s.NTPServers) == 0) {
		return fmt.Errorf("invalid peer count")
	}
	for _, h := range s.NTPServers {
		if !IsValidNtpServerHost(h) {
			return fmt.Errorf("invalid NTP server host")
		}
	}
	if s.Timezone.ExpectedWindowsID != nil && !zoneSyntax(*s.Timezone.ExpectedWindowsID) {
		return fmt.Errorf("invalid timezone ID")
	}
	return nil
}
func canonicalObject(m map[string]json.RawMessage, aliases map[string]string, required []string) error {
	for old, next := range aliases {
		if v, ok := m[old]; ok {
			if _, exists := m[next]; exists {
				return fmt.Errorf("duplicate settings alias %s", next)
			}
			m[next] = v
			delete(m, old)
		}
	}
	allowed := map[string]bool{}
	for _, key := range required {
		allowed[key] = true
		if _, ok := m[key]; !ok {
			return fmt.Errorf("missing %s", key)
		}
	}
	for key := range m {
		if !allowed[key] {
			return fmt.Errorf("unknown setting %s", key)
		}
	}
	return nil
}
func ParseSettings(raw any) (Settings, error) {
	var out Settings
	b, err := json.Marshal(raw)
	if err != nil {
		return out, err
	}
	var m map[string]json.RawMessage
	if err = json.Unmarshal(b, &m); err != nil || m == nil {
		return out, fmt.Errorf("settings must be an object")
	}
	err = canonicalObject(m, map[string]string{"enforceNtp": "enforce_ntp", "ntpServers": "ntp_servers", "pollIntervalMinutes": "poll_interval_minutes"},
		[]string{"enforce_ntp", "ntp_servers", "poll_interval_minutes", "timezone", "fingerprint"})
	if err != nil {
		return out, err
	}
	var z map[string]json.RawMessage
	if err = json.Unmarshal(m["timezone"], &z); err != nil || z == nil {
		return out, fmt.Errorf("timezone must be an object")
	}
	if err = canonicalObject(z, map[string]string{"expectedWindowsId": "expected_windows_id", "autoFix": "auto_fix"}, []string{"expected_windows_id", "auto_fix"}); err != nil {
		return out, err
	}
	for _, key := range []string{"enforce_ntp", "ntp_servers", "poll_interval_minutes", "fingerprint"} {
		if string(m[key]) == "null" {
			return out, fmt.Errorf("null %s", key)
		}
	}
	if string(z["auto_fix"]) == "null" {
		return out, fmt.Errorf("null auto_fix")
	}
	m["timezone"], err = json.Marshal(z)
	if err != nil {
		return out, err
	}
	b, err = json.Marshal(m)
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(b, &out); err != nil {
		return out, err
	}
	return out, ValidateSettings(out)
}
