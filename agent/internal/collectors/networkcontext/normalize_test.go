package networkcontext

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
)

func TestNormalizeRoutesPreservesZonesAndEqualMetrics(t *testing.T) {
	rows := []RouteRow{}
	for _, name := range []string{"if2", "if3"} {
		rows = append(rows, RouteRow{Family: "ipv6", DestinationPrefix: "::/0", TableKey: "main", RouteType: "unicast", Metric: ptr(uint32(1)), InterfaceKey: ptr(name), NextHops: []NextHop{{Address: ptr("fe80::1"), Zone: ptr(name), InterfaceKey: ptr(name)}}})
	}
	got, err := NormalizeRoutes(rows)
	if err != nil || len(got) != 2 {
		t.Fatalf("got=%v err=%v", got, err)
	}
	rows[0], rows[1] = rows[1], rows[0]
	other, err := NormalizeRoutes(rows)
	if err != nil || !reflect.DeepEqual(got, other) {
		t.Fatal("unstable ordering")
	}
}
func TestNormalizeRejectsInvalidAddresses(t *testing.T) {
	for _, tc := range []struct {
		name, ip string
		zone     *string
	}{
		{"missing IPv6 zone", "fe80::1", nil}, {"IPv4 zone", "192.0.2.1", ptr("if1")}, {"malformed", "invalid", nil}, {"conflicting zone", "fe80::1%if1", ptr("if2")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := normalizeIP(tc.ip, tc.zone); err == nil {
				t.Fatal("accepted invalid address")
			}
		})
	}
}
func TestNormalizeInterfacesRetainsInactiveAndCanonicalizes(t *testing.T) {
	got, err := NormalizeInterfaces([]InterfaceRow{{InterfaceKey: "persistent-adapter", Name: "eth0", AdminState: "down", CurrentMAC: "00-AA-BB-CC-DD-EE", Addresses: []AddressRow{{Address: "2001:0db8::1", Family: "ipv6", PrefixLength: 64}}}})
	if err != nil || got[0].CurrentMAC != "00:aa:bb:cc:dd:ee" || got[0].Addresses[0].Address != "2001:db8::1" || got[0].AdminState != "down" {
		t.Fatal(got, err)
	}
}
func TestReadErrorClassification(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{{context.Canceled, "timeout"}, {os.ErrPermission, "permission_denied"}, {ErrUnsupported, "unsupported"}, {ErrLimit, "limit_exceeded"}, {errors.New("secret OS output"), "malformed"}} {
		if got := classifyReadError(tc.err); got != tc.code {
			t.Fatal(got)
		}
	}
}
func TestFinishSectionDoesNotTurnFailureIntoEmptyComplete(t *testing.T) {
	s := finishSection(Section[int]{}, "routes", "ctx", 2, os.ErrPermission)
	if s.Outcome != Failed || s.Rows == nil || s.ReasonCode != "permission_denied" {
		t.Fatal(s)
	}
	s = finishSection(Section[int]{Rows: []int{1, 2, 3}}, "routes", "ctx", 2, nil)
	if s.Outcome != Partial || s.RowCount != 2 || s.OmittedRowCount != 1 {
		t.Fatal(s)
	}
}
func TestScopeKeysCannotCollide(t *testing.T) {
	if ScopeKey("a|b", "c", "d", "e") == ScopeKey("a", "b|c", "d", "e") {
		t.Fatal("colliding scope keys")
	}
}

func TestRouteRetentionPriority(t *testing.T) {
	gateway := "192.0.2.1"
	cases := []struct {
		row  RouteRow
		want int
	}{
		{RouteRow{DestinationPrefix: "0.0.0.0/0"}, 0},
		{RouteRow{DestinationPrefix: "::/0"}, 0},
		{RouteRow{DestinationPrefix: "192.0.2.0/24"}, 1},
		{RouteRow{DestinationPrefix: "198.51.100.0/24", NextHops: []NextHop{{Address: &gateway}}}, 2},
	}
	for _, tc := range cases {
		if got := routePriority(tc.row); got != tc.want {
			t.Fatal(tc.row, got)
		}
	}
}
