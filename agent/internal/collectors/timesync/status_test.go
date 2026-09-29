package timesync

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

const germanStatus = `Sprungindikator: 0(keine Warnung)
Stratum: 4 (Sekundärreferenz)
Präzision: -23
Stammverzögerung: 0.001s
Stammabweichung: 0.004s
Referenz-ID: 0x4C4F434C (Quellenname: "LOCL")
Letzte erfolgreiche Synchronisierungszeit: 28.09.2026 14:00:00
Quelle: Lokale CMOS-Uhr
Abrufintervall: 6 (64s)
Phasenoffset: 0.00001s`

func TestGermanTokensNeverParseTranslatedValues(t *testing.T) {
	got := parseW32tmTokens(germanStatus)
	if got.Source != nil || got.LastSuccessfulSyncAt != nil || got.LastSyncError != nil || got.SourceKind != "unknown" {
		t.Fatalf("localized or ambiguous value inferred: %+v", got)
	}
	// Token-disabled variant: Task 1 proved the line layout on English
	// Server 2022 only; the German (L9) and Windows 10 / Server 2016 floor
	// comparisons are owed, so no position-based numeric field is read.
	if got.Stratum != nil || got.PollIntervalSeconds != nil {
		t.Fatal("unproven token parsed")
	}
	english := strings.NewReplacer("Sprungindikator", "Leap Indicator", "Stratum", "Stratum",
		"Präzision", "Precision", "Stammverzögerung", "Root Delay", "Stammabweichung", "Root Dispersion",
		"Referenz-ID", "ReferenceId", "Letzte erfolgreiche Synchronisierungszeit", "Last Successful Sync Time",
		"Quelle", "Source", "Abrufintervall", "Poll Interval", "Lokale CMOS-Uhr", "Local CMOS Clock").Replace(germanStatus)
	if other := parseW32tmTokens(english); !reflect.DeepEqual(got, other) {
		t.Fatalf("locale changed facts: %+v %+v", got, other)
	}
	for _, raw := range []string{"", "Quelle: Zeitserver", strings.Replace(germanStatus, "0x4C4F434C", "bad-reference", 1)} {
		got := parseW32tmTokens(raw)
		if got.Source != nil || got.Stratum != nil || got.PollIntervalSeconds != nil {
			t.Fatalf("malformed layout accepted: %+v", got)
		}
	}
}

func TestProviderKindsAndLadder(t *testing.T) {
	for _, kind := range []string{"ntp_peer", "domain_peer", "local_clock", "free_running", "vm_host", "unknown"} {
		f := &fakeSystem{provider: Status{Source: ptr("structured source"), SourceKind: kind, Stratum: ptr(2)}}
		got := readStatus(context.Background(), f, nil)
		if got.Method != "provider_api" || got.SourceKind != kind || *got.Source != "structured source" {
			t.Fatal(got)
		}
	}
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	// Event 35 ("now synchronizing with") names the chosen source. Its
	// host,0xN (ntp.m|...) insertion form on an NTP-active host is inferred
	// from the message template; the lab VM's 35s are all VMIC (L-owed).
	success := Event{EventID: 35, OccurredAt: at, Properties: []string{"peer.example.com,0x9 (ntp.m|0x9|transport)"}}
	for _, tc := range []struct{ typ, role, kind string }{
		{"NTP", "workgroup", "ntp_peer"}, {"NT5DS", "member", "domain_peer"}, {"AllSync", "member", "unknown"},
	} {
		e := success
		if tc.kind == "domain_peer" {
			e.Properties = []string{"dc.example.com (ntp.d|transport)"}
		}
		if tc.kind == "unknown" {
			e.Properties = []string{"peer.example.com"}
		}
		f := &fakeSystem{tokens: []byte(germanStatus)}
		got := readStatus(context.Background(), f, []Event{e})
		// Events 35/37 fire on service start and source change, not on
		// every sync, so their time is never a last-successful-sync time.
		if got.Method != "events" || got.SourceKind != tc.kind || got.LastSuccessfulSyncAt != nil {
			t.Fatal(got)
		}
		if got.Stratum != nil {
			t.Fatal("unproven token parsed")
		}
	}
	f := &fakeSystem{}
	if got := readStatus(context.Background(), f, nil); got.Method != "unavailable" || got.Source != nil {
		t.Fatal(got)
	}
	f.provider = Status{Source: ptr("peer.example.com"), SourceKind: "ntp_peer"}
	f.providerErr = errUnavailable
	if got := readStatus(context.Background(), f, []Event{success}); got.Method != "events" {
		t.Fatal(got)
	}
}

func TestPlainEventHostsNeverInferKindFromConfiguration(t *testing.T) {
	for _, typ := range []string{"NTP", "NT5DS"} {
		t.Run(typ, func(t *testing.T) {
			at := time.Unix(100, 0).UTC()
			f := &fakeSystem{strings: map[string]string{serviceKey + `\Parameters|Type`: typ},
				role: RoleInfo{MachineRole: 3, DomainDNS: "example.com", ForestDNS: "example.com"}}
			e := Event{EventID: 35, OccurredAt: at, Properties: []string{"peer.example.com"}}
			got := readStatus(context.Background(), f, []Event{e})
			if got.Source == nil || *got.Source != "peer.example.com" || got.SourceKind != "unknown" || got.LastSuccessfulSyncAt != nil {
				t.Fatal(got)
			}
		})
	}
}

func TestEventsAreLastKnownGoodNotTranslatedStatus(t *testing.T) {
	at := time.Unix(100, 0).UTC()
	bad := Event{EventID: 35, OccurredAt: at, Properties: []string{"Freilaufende Systemuhr"}, Message: "time.example.com"}
	got := readStatus(context.Background(), &fakeSystem{}, []Event{bad})
	if got.Source != nil || got.SourceKind != "unknown" || got.LastSuccessfulSyncAt != nil {
		t.Fatalf("display text parsed: %+v", got)
	}
	got = readStatus(context.Background(), &fakeSystem{}, nil)
	if got.Source != nil || got.LastSuccessfulSyncAt != nil {
		t.Fatal("invented cached status", got)
	}
}

// Lab pair from the Windows lab VM (Hyper-V guest, VMIC active per
// w32tm /query /source): NtpClient keeps emitting 37 for its peer, then 35
// names the VM IC provider. Only the newest 35 may name the source; an
// unparsable newest 35 must never fall back to an older 35 or to any 37.
func TestOnlyNewestEvent35NamesTheSource(t *testing.T) {
	t37 := time.Date(2026, 9, 28, 21, 35, 53, 0, time.UTC)
	t35 := t37.Add(3 * time.Second)
	peer37 := Event{RecordID: 10, EventID: 37, OccurredAt: t37, Properties: []string{"time.windows.com,0x8 (ntp.m|0x8|0.0.0.0:123->192.0.2.1:123)"}}
	vmic35 := Event{RecordID: 11, EventID: 35, OccurredAt: t35, Properties: []string{"VM IC Time Synchronization Provider", "1347702102", "3"}}
	older35 := Event{RecordID: 5, EventID: 35, OccurredAt: t37.Add(-time.Hour), Properties: []string{"time.windows.com,0x8 (ntp.m|0x8|0.0.0.0:123->192.0.2.1:123)"}}
	for name, events := range map[string][]Event{
		"lab pair":           {peer37, vmic35},
		"lab pair reversed":  {vmic35, peer37},
		"older parsable 35":  {older35, peer37, vmic35},
		"only a 37":          {peer37},
		"newer 37 than a 35": {older35, peer37},
	} {
		t.Run(name, func(t *testing.T) {
			got := readStatus(context.Background(), &fakeSystem{}, events)
			if name == "newer 37 than a 35" {
				// A newer 37 (peer receiving data) does not displace the
				// chosen source named by the newest 35.
				if got.Method != "events" || got.Source == nil || *got.Source != "time.windows.com" || got.SourceKind != "ntp_peer" || got.LastSuccessfulSyncAt != nil {
					t.Fatalf("%+v", got)
				}
				return
			}
			if got.Method != "unavailable" || got.Source != nil || got.SourceKind != "unknown" || got.LastSuccessfulSyncAt != nil {
				t.Fatalf("peer or guess reported as source: %+v", got)
			}
		})
	}
	// Same timestamp: the higher record ID is the newer event.
	a := Event{RecordID: 20, EventID: 35, OccurredAt: t35, Properties: []string{"a.example.com,0x9 (ntp.m|0x9|x)"}}
	b := Event{RecordID: 21, EventID: 35, OccurredAt: t35, Properties: []string{"b.example.com,0x9 (ntp.m|0x9|x)"}}
	for _, events := range [][]Event{{a, b}, {b, a}} {
		if got := readStatus(context.Background(), &fakeSystem{}, events); got.Source == nil || *got.Source != "b.example.com" {
			t.Fatalf("tie not broken by record ID: %+v", got)
		}
	}
}
