package hyperv

import (
	"strings"
	"testing"
)

func TestParseExportEstimate(t *testing.T) {
	cases := []struct {
		name    string
		out     string
		want    int64
		wantErr string
	}{
		{name: "disks plus memory", out: `{"vhdBytes":12884901888,"memoryBytes":4294967296,"state":"Running"}`, want: 12884901888 + 4294967296},
		{name: "off VM", out: "{\"vhdBytes\":1000,\"memoryBytes\":0,\"state\":\"Off\"}\r\n", want: 1000},
		{name: "warning line before JSON", out: "WARNING: something noisy\n{\"vhdBytes\":5,\"memoryBytes\":1,\"state\":\"Saved\"}", want: 6},
		{name: "no JSON", out: "Get-VHD : The term 'Get-VHD' is not recognized", wantErr: "produced no JSON"},
		{name: "no disks", out: `{"vhdBytes":0,"memoryBytes":0,"state":"Off"}`, wantErr: "no virtual disk files"},
		{name: "negative", out: `{"vhdBytes":-1,"memoryBytes":0,"state":"Off"}`, wantErr: "negative"},
		{name: "malformed", out: `{"vhdBytes":`, wantErr: "parse export size estimate"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseExportEstimate(tc.out)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %d, want %d", got, tc.want)
			}
		})
	}
}
