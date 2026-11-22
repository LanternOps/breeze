package netattach

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// The exact JSON of spec §7.1, compacted.
const specReport = `{"epoch":"9f2c1e7ab4d04c11","sequence":418,"capturedAt":"2026-11-20T15:04:05Z","complete":true,"attachments":[{"interfaceName":"Ethernet","localAddress":"192.168.1.57","prefixLength":24,"gatewayAddress":"192.168.1.1","gatewayMac":"a4:2b:b0:11:22:9c","primary":true}]}`

var reportNow = time.Date(2026, 11, 20, 10, 4, 5, 987_000_000, time.FixedZone("EST", -5*3600))

func TestBuildReport_MatchesSpecJSON(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`) // Next -> 418
	cur := func(_ context.Context, host string) ([]Attachment, bool, error) {
		if host != "breeze.example" {
			t.Errorf("serverHost = %q", host)
		}
		return []Attachment{{InterfaceName: "Ethernet", InterfaceIndex: 7,
			LocalAddress: netip.MustParseAddr("192.168.1.57"), PrefixLength: 24,
			GatewayAddress: netip.MustParseAddr("192.168.1.1"),
			GatewayMAC:     mustMAC(t, "a4:2b:b0:11:22:9c"), Primary: true}}, true, nil
	}
	b, _ := json.Marshal(buildReport(context.Background(), st, "breeze.example", reportNow, cur))
	if string(b) != specReport {
		t.Fatalf("got  %s\nwant %s", b, specReport)
	}
}

func marshalReport(t *testing.T, cur func(context.Context, string) ([]Attachment, bool, error)) (Report, string) {
	t.Helper()
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`)
	r := buildReport(context.Background(), st, "breeze.example", reportNow, cur)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return r, string(b)
}

func TestBuildReport_EmptyCompleteList(t *testing.T) {
	_, got := marshalReport(t, func(context.Context, string) ([]Attachment, bool, error) { return nil, true, nil })
	if !strings.Contains(got, `"complete":true,"attachments":[]`) {
		t.Fatalf("got %s", got)
	}
}

func TestBuildReport_NilMACIsNull(t *testing.T) {
	_, got := marshalReport(t, func(context.Context, string) ([]Attachment, bool, error) {
		return []Attachment{{InterfaceName: "Wi-Fi", LocalAddress: netip.MustParseAddr("10.1.2.57"), PrefixLength: 24, GatewayAddress: netip.MustParseAddr("10.1.2.100")}}, true, nil
	})
	if !strings.Contains(got, `"gatewayMac":null`) {
		t.Fatalf("got %s", got)
	}
}

func TestBuildReport_ReadErrorIsIncomplete(t *testing.T) {
	r, _ := marshalReport(t, func(context.Context, string) ([]Attachment, bool, error) {
		return []Attachment{{InterfaceName: "Wi-Fi", LocalAddress: netip.MustParseAddr("10.1.2.57"), PrefixLength: 24, GatewayAddress: netip.MustParseAddr("10.1.2.100")}}, true, errors.New("x")
	})
	if r.Complete || len(r.Attachments) != 1 || r.Epoch == "" {
		t.Fatalf("got %+v", r)
	}
}

func TestBuildReport_StateFailureGivesZeroReport(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`)
	st.persist = func(string, []byte) error { return errors.New("disk full") }
	st.random = failingReader{}
	r := buildReport(context.Background(), st, "breeze.example", reportNow, func(context.Context, string) ([]Attachment, bool, error) {
		return nil, true, nil
	})
	if r.Epoch != "" || r.Sequence != 0 || r.Attachments != nil {
		t.Fatalf("got %+v, want the zero Report", r)
	}
}

func TestBuildReport_SequenceIncreases(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`)
	cur := func(context.Context, string) ([]Attachment, bool, error) { return nil, true, nil }
	a := buildReport(context.Background(), st, "", reportNow, cur)
	b := buildReport(context.Background(), st, "", reportNow, cur)
	if b.Sequence != a.Sequence+1 || a.Epoch != b.Epoch || a.Epoch == "" {
		t.Fatalf("a=%+v b=%+v", a, b)
	}
}

func TestBuildReport_ReadsBeforeSequence(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`)
	var seqDuringRead uint64
	r := buildReport(context.Background(), st, "", reportNow, func(context.Context, string) ([]Attachment, bool, error) {
		seqDuringRead = st.next
		return nil, true, nil
	})
	if seqDuringRead != 418 || r.Sequence != 418 {
		t.Fatalf("next during read = %d, report sequence %d", seqDuringRead, r.Sequence)
	}
}
