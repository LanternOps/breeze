package timesync

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"unicode/utf16"
)

func settingsFixture() Settings {
	return Settings{EnforceNTP: true, NTPServers: []string{"time.cloudflare.com", "pool.ntp.org"},
		PollIntervalMinutes: 60, Fingerprint: "sha256:" + strings.Repeat("a", 64)}
}
func rawSettings(t *testing.T, s Settings) map[string]any {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err = json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
func hostFixture(t *testing.T) (valid, invalid []string) {
	t.Helper()
	// Four parent components: package -> collectors -> internal -> agent -> repository.
	b, err := os.ReadFile("../../../../packages/shared/src/validators/__fixtures__/ntpServers.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Valid, Invalid []string }
	if err = json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Valid) == 0 || len(f.Invalid) == 0 {
		t.Fatal("empty shared host fixture")
	}
	return f.Valid, f.Invalid
}
func TestManagementSettingsHostFixture(t *testing.T) {
	valid, invalid := hostFixture(t)
	for _, host := range valid {
		s := settingsFixture()
		s.NTPServers = []string{host}
		if _, err := ParseSettings(rawSettings(t, s)); err != nil {
			t.Fatalf("valid %q: %v", host, err)
		}
	}
	for _, host := range invalid {
		s := settingsFixture()
		s.NTPServers = []string{host}
		if _, err := ParseSettings(rawSettings(t, s)); err == nil {
			t.Fatalf("accepted invalid %q", host)
		}
	}
}
func TestManagementSettingsShape(t *testing.T) {
	for _, camel := range []bool{false, true} {
		m := rawSettings(t, settingsFixture())
		if camel {
			for a, b := range map[string]string{"enforce_ntp": "enforceNtp", "ntp_servers": "ntpServers", "poll_interval_minutes": "pollIntervalMinutes"} {
				m[b] = m[a]
				delete(m, a)
			}
			z := m["timezone"].(map[string]any)
			z["autoFix"] = z["auto_fix"]
			delete(z, "auto_fix")
			z["expectedWindowsId"] = z["expected_windows_id"]
			delete(z, "expected_windows_id")
		}
		if _, err := ParseSettings(m); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"missing", func(m map[string]any) { delete(m, "enforce_ntp") }},
		{"fraction", func(m map[string]any) { m["poll_interval_minutes"] = 15.5 }},
		{"low", func(m map[string]any) { m["poll_interval_minutes"] = 14 }},
		{"high", func(m map[string]any) { m["poll_interval_minutes"] = 1441 }},
		{"empty", func(m map[string]any) { m["ntp_servers"] = []string{} }},
		{"six", func(m map[string]any) { m["ntp_servers"] = []string{"a", "b", "c", "d", "e", "f"} }},
		{"null", func(m map[string]any) { m["ntp_servers"] = nil }},
		{"unknown", func(m map[string]any) { m["extra"] = true }},
		{"aliases", func(m map[string]any) { m["enforceNtp"] = true }},
		{"fingerprint", func(m map[string]any) { m["fingerprint"] = "" }},
		{"zone-path", func(m map[string]any) { m["timezone"].(map[string]any)["expected_windows_id"] = `..\UTC` }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := rawSettings(t, settingsFixture())
			tc.change(m)
			if _, err := ParseSettings(m); err == nil {
				t.Fatal("accepted invalid settings")
			}
		})
	}
	s := settingsFixture()
	s.EnforceNTP = false
	s.NTPServers = []string{}
	if _, err := ParseSettings(rawSettings(t, s)); err != nil {
		t.Fatal(err)
	}
}
func TestManagementResultNulls(t *testing.T) {
	r := EnforcementResult{Before: map[string]any{"type": nil}, After: map[string]any{"type": nil}}
	b, err := json.Marshal(ManagementReport{NTP: &r})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"timezone":null`) || !strings.Contains(string(b), `"error":null`) {
		t.Fatal(string(b))
	}
}

// invalidDeliveries are payloads whose rejection used to depend on Go's randomised
// map iteration: the first unknown key or duplicate alias found named the error.
func invalidDeliveries(t *testing.T) map[string]func() map[string]any {
	t.Helper()
	return map[string]func() map[string]any{
		"unknown-top": func() map[string]any {
			m := rawSettings(t, settingsFixture())
			m["futureA"], m["futureB"], m["futureC"] = true, 1, "x"
			return m
		},
		"unknown-timezone": func() map[string]any {
			m := rawSettings(t, settingsFixture())
			z := m["timezone"].(map[string]any)
			z["futureA"], z["futureB"], z["futureC"] = true, 1, "x"
			return m
		},
		"duplicate-alias": func() map[string]any {
			m := rawSettings(t, settingsFixture())
			m["enforceNtp"], m["ntpServers"], m["pollIntervalMinutes"] = m["enforce_ntp"], m["ntp_servers"], m["poll_interval_minutes"]
			return m
		},
	}
}
func TestManagementSettingsErrorsAreDeterministic(t *testing.T) {
	want := map[string]string{
		"unknown-top":      "unknown settings futureA, futureB, futureC",
		"unknown-timezone": "unknown settings futureA, futureB, futureC",
		"duplicate-alias":  "duplicate settings aliases enforce_ntp, ntp_servers, poll_interval_minutes",
	}
	for name, build := range invalidDeliveries(t) {
		t.Run(name, func(t *testing.T) {
			for i := 0; i < 50; i++ {
				_, err := ParseSettings(build())
				if err == nil || err.Error() != want[name] {
					t.Fatalf("delivery %d: got %v, want %q", i, err, want[name])
				}
			}
		})
	}
}
func TestManagementErrorLengthUsesUTF16(t *testing.T) {
	message := errorText(errors.New(strings.Repeat("😀", 300)))
	if message == nil || len(utf16.Encode([]rune(*message))) != 512 {
		t.Fatal(message)
	}
	if errorText(nil) != nil {
		t.Fatal("nil error must stay null")
	}
	if ntpValues(Observation{})["serviceStartType"] != nil {
		t.Fatal("unknown start type must be null")
	}
}
