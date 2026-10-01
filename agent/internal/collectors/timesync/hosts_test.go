package timesync

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestSharedHostFixture(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/shared/src/validators/__fixtures__/ntpServers.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Valid   []string `json:"valid"`
		Invalid []string `json:"invalid"`
	}
	if err = json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Valid) == 0 || len(f.Invalid) == 0 {
		t.Fatal("empty shared fixture")
	}
	for _, s := range f.Valid {
		if !IsValidNtpServerHost(s) {
			t.Errorf("valid host rejected: %q", s)
		}
	}
	for _, s := range f.Invalid {
		if IsValidNtpServerHost(s) {
			t.Errorf("invalid host accepted: %q", s)
		}
	}
}

func TestParseNtpServerHosts(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want []string
	}{
		{"  time.a.com,0x9   time.b.com,0x8  ", []string{"time.a.com", "time.b.com"}},
		{"time.a.com,0x1,0x8", []string{"time.a.com"}},
		{"", []string{}},
		{"\tpeer.example.com,0x9\npeer.example.com,0x8", []string{"peer.example.com", "peer.example.com"}},
	} {
		if got := ParseNtpServerHosts(tc.raw); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%q: %v", tc.raw, got)
		}
	}
}
