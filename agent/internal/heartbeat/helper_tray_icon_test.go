package heartbeat

import (
	"encoding/json"
	"testing"
)

// #3202: showTrayIcon is a *bool precisely so an OLDER server that never sends
// the field cannot be read as "hide the icon". Decoding a payload without the
// key must resolve to visible; only an explicit false hides it.
func TestTrayIconVisibleDefaultsToTrueWhenServerOmitsField(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{"omitted (pre-#3202 server)", `{"enabled":true}`, true},
		{"explicit true", `{"enabled":true,"showTrayIcon":true}`, true},
		{"explicit false", `{"enabled":true,"showTrayIcon":false}`, false},
		{"explicit null", `{"enabled":true,"showTrayIcon":null}`, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var hs HelperSettings
			if err := json.Unmarshal([]byte(tc.body), &hs); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got := trayIconVisible(hs.ShowTrayIcon); got != tc.want {
				t.Fatalf("trayIconVisible = %v, want %v", got, tc.want)
			}
		})
	}
}
