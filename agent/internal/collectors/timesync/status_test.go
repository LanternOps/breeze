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
	success := Event{EventID: 37, OccurredAt: at, Properties: []string{"peer.example.com,0x9 (ntp.m|0x9|transport)"}}
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
		if got.Method != "events" || got.SourceKind != tc.kind || !got.LastSuccessfulSyncAt.Equal(at) {
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
			e := Event{EventID: 37, OccurredAt: at, Properties: []string{"peer.example.com"}}
			got := readStatus(context.Background(), f, []Event{e})
			if got.Source == nil || *got.Source != "peer.example.com" || got.SourceKind != "unknown" || !got.LastSuccessfulSyncAt.Equal(at) {
				t.Fatal(got)
			}
		})
	}
}

func TestEventsAreLastKnownGoodNotTranslatedStatus(t *testing.T) {
	at := time.Unix(100, 0).UTC()
	bad := Event{EventID: 35, OccurredAt: at, Properties: []string{"Freilaufende Systemuhr"}, Message: "time.example.com"}
	got := readStatus(context.Background(), &fakeSystem{}, []Event{bad})
	if got.Source != nil || got.SourceKind != "unknown" {
		t.Fatalf("display text parsed: %+v", got)
	}
	got = readStatus(context.Background(), &fakeSystem{}, nil)
	if got.Source != nil || got.LastSuccessfulSyncAt != nil {
		t.Fatal("invented cached status", got)
	}
}
