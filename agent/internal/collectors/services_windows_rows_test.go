package collectors

import (
	"encoding/json"
	"testing"
)

// TestWindowsServiceFromRow_Issue8904 decodes the exact JSON shape
// ConvertTo-Json writes for the corrupt CIM read in #8904 (four NULs in place
// of "Loca") and checks the agent strips them and flags the field unreliable.
func TestWindowsServiceFromRow_Issue8904(t *testing.T) {
	raw := `{"Name":"GoogleUpdaterInternalService156.0.8067.0","DisplayName":"Google Updater Internal Service (GoogleUpdaterInternalService156.0.8067.0)","State":"Running","StartMode":"Auto","StartName":"\u0000\u0000\u0000\u0000lSystem"}`

	var row windowsServiceInfo
	if err := json.Unmarshal([]byte(raw), &row); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if row.StartName != "\x00\x00\x00\x00lSystem" {
		t.Fatalf("decoded StartName = %q, want the four-NUL bytes from the issue", row.StartName)
	}

	svc, ok := windowsServiceFromRow(row)
	if !ok {
		t.Fatal("windowsServiceFromRow rejected a row with a valid name")
	}
	if svc.Account != "lSystem" {
		t.Errorf("Account = %q, want %q", svc.Account, "lSystem")
	}
	if !svc.accountUnreliable {
		t.Error("accountUnreliable = false, want true for a read that contained NULs")
	}
	if svc.startupTypeUnreliable {
		t.Error("startupTypeUnreliable = true for a clean StartMode")
	}
	if svc.StartupType != "automatic" || svc.State != "running" {
		t.Errorf("unexpected normalisation: %#v", svc)
	}
}

func TestWindowsServiceFromRow(t *testing.T) {
	cases := []struct {
		name           string
		row            windowsServiceInfo
		wantOK         bool
		want           ServiceInfo
		wantAcctBad    bool
		wantStartupBad bool
	}{
		{
			name:   "clean row",
			row:    windowsServiceInfo{Name: " Spooler ", DisplayName: "Print Spooler", State: "Running", StartMode: "Auto", StartName: "LocalSystem"},
			wantOK: true,
			want:   ServiceInfo{Name: "Spooler", DisplayName: "Print Spooler", State: "running", StartupType: "automatic", Account: "LocalSystem"},
		},
		{
			name:           "NUL in start mode",
			row:            windowsServiceInfo{Name: "Svc", State: "Stopped", StartMode: "\x00\x00to", StartName: "LocalSystem"},
			wantOK:         true,
			want:           ServiceInfo{Name: "Svc", State: "stopped", StartupType: "to", Account: "LocalSystem"},
			wantStartupBad: true,
		},
		{
			name:   "NUL in display name is stripped",
			row:    windowsServiceInfo{Name: "Svc", DisplayName: "My\x00 Service", State: "Running", StartMode: "Manual", StartName: "LocalSystem"},
			wantOK: true,
			want:   ServiceInfo{Name: "Svc", DisplayName: "My Service", State: "running", StartupType: "manual", Account: "LocalSystem"},
		},
		{
			name:   "NUL in name is stripped",
			row:    windowsServiceInfo{Name: "Sv\x00c", State: "Running", StartMode: "Manual"},
			wantOK: true,
			want:   ServiceInfo{Name: "Svc", State: "running", StartupType: "manual"},
		},
		{
			name:   "all-NUL name is skipped",
			row:    windowsServiceInfo{Name: "\x00\x00\x00", State: "Running", StartMode: "Manual"},
			wantOK: false,
		},
		{
			name:   "empty name is skipped",
			row:    windowsServiceInfo{Name: "  ", State: "Running"},
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := windowsServiceFromRow(tc.row)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (got %#v)", ok, tc.wantOK, got)
			}
			if !ok {
				return
			}
			if got.accountUnreliable != tc.wantAcctBad || got.startupTypeUnreliable != tc.wantStartupBad {
				t.Errorf("unreliable flags = (account %v, startup %v), want (%v, %v)",
					got.accountUnreliable, got.startupTypeUnreliable, tc.wantAcctBad, tc.wantStartupBad)
			}
			got.accountUnreliable, got.startupTypeUnreliable = false, false
			if got != tc.want {
				t.Errorf("windowsServiceFromRow = %#v, want %#v", got, tc.want)
			}
		})
	}
}
