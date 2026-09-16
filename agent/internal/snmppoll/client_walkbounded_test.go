package snmppoll

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/gosnmp/gosnmp"
)

func TestWalkBounded_EmptyOIDReturnsError(t *testing.T) {
	err := (&SNMPClient{client: &gosnmp.GoSNMP{}}).WalkBounded("", func(gosnmp.SnmpPDU) error { return nil })
	if err == nil {
		t.Fatal("WalkBounded(\"\") = nil error, want non-nil")
	}
	if !strings.Contains(err.Error(), "oid is required") {
		t.Errorf("WalkBounded(\"\") error = %q, want it to name the missing oid", err.Error())
	}
}

func TestWalkBounded_NilClientReturnsError(t *testing.T) {
	if err := (&SNMPClient{client: nil}).WalkBounded("1.3.6", func(gosnmp.SnmpPDU) error { return nil }); err == nil {
		t.Fatal("WalkBounded with nil client = nil error, want non-nil")
	}
}

func TestWalkBounded_NilCallbackReturnsError(t *testing.T) {
	if err := (&SNMPClient{client: &gosnmp.GoSNMP{}}).WalkBounded("1.3.6", nil); err == nil {
		t.Fatal("WalkBounded with nil callback = nil error, want non-nil")
	}
}

func TestWalkBulkPages_ReportsStatusAfterPartialPages(t *testing.T) {
	for _, status := range []gosnmp.SNMPError{gosnmp.NoAccess, gosnmp.AuthorizationError, gosnmp.GenErr, gosnmp.TooBig} {
		for _, count := range []int{0, 3} {
			t.Run(fmt.Sprintf("%s/%d", status, count), func(t *testing.T) {
				calls, values := 0, 0
				getBulk := func(oids []string, nonRepeaters uint8, repetitions uint32) (*gosnmp.SnmpPacket, error) {
					calls++
					if nonRepeaters != 0 || repetitions != 17 {
						t.Fatalf("bulk limits = %d/%d", nonRepeaters, repetitions)
					}
					if calls == 1 && count > 0 {
						if len(oids) != 1 || oids[0] != walkSpec().OID {
							t.Fatalf("initial cursor = %v", oids)
						}
						return &gosnmp.SnmpPacket{Variables: walkRows(suppliesLevel, count)}, nil
					}
					if count > 0 && oids[0] != walkSpec().OID+".3" {
						t.Fatalf("next cursor = %v", oids)
					}
					return &gosnmp.SnmpPacket{Error: status, ErrorIndex: 2}, nil
				}
				err := walkBulkPages(suppliesLevel, func(gosnmp.SnmpPDU) error { values++; return nil }, getBulk, 17)
				var statusErr *SnmpStatusError
				if !errors.As(err, &statusErr) || statusErr.Status != status || statusErr.Index != 2 || values != count {
					t.Fatalf("values=%d, error=%v, want %d values and status %s index 2", values, err, count, status)
				}
			})
		}
	}
}

func TestWalkBulkPages_StopsAndChecksNumericProgress(t *testing.T) {
	stopErr := errors.New("callback limit")
	for _, tt := range []struct {
		name        string
		pdus        []gosnmp.SnmpPDU
		callbackErr error
		wantValues  int
		wantError   string
	}{
		{name: "numeric 9 to 10", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.6.9"}, {Name: ".1.3.6.10"}, {Name: ".1.3.7.1"}}, wantValues: 2},
		{name: "same OID", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.6.1"}, {Name: ".1.3.6.1"}}, wantValues: 1, wantError: "OID not increasing"},
		{name: "decreasing OID", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.6.10"}, {Name: ".1.3.6.9"}}, wantValues: 1, wantError: "OID not increasing"},
		{name: "outside subtree", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.60.1"}}},
		{name: "end of MIB", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.6.1", Type: gosnmp.EndOfMibView}}},
		{name: "no such object", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.6.1", Type: gosnmp.NoSuchObject}}},
		{name: "no such instance", pdus: []gosnmp.SnmpPDU{{Name: ".1.3.6.1", Type: gosnmp.NoSuchInstance}}},
		{name: "empty page"},
		{name: "callback stop", pdus: walkRows(".1.3.6", 3), callbackErr: stopErr, wantValues: 1, wantError: "callback limit"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			calls, values := 0, 0
			getBulk := func([]string, uint8, uint32) (*gosnmp.SnmpPacket, error) {
				calls++
				if calls > 1 {
					t.Fatal("walk must stop before another page")
				}
				return &gosnmp.SnmpPacket{Variables: tt.pdus}, nil
			}
			err := walkBulkPages("1.3.6", func(gosnmp.SnmpPDU) error { values++; return tt.callbackErr }, getBulk, 10)
			if values != tt.wantValues {
				t.Errorf("values=%d want %d", values, tt.wantValues)
			}
			if tt.wantError == "" && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if tt.wantError != "" && (err == nil || !strings.Contains(err.Error(), tt.wantError)) {
				t.Fatalf("error=%v want %s", err, tt.wantError)
			}
			if tt.callbackErr != nil && !errors.Is(err, tt.callbackErr) {
				t.Fatal("callback sentinel was lost")
			}
		})
	}
}

func TestWalkBulkPages_TransportErrorAndEmptyResponse(t *testing.T) {
	transportErr := errors.New("connection refused")
	for _, tt := range []struct {
		name string
		err  error
	}{{"transport", transportErr}, {"nil packet", nil}} {
		t.Run(tt.name, func(t *testing.T) {
			err := walkBulkPages("1.3.6", func(gosnmp.SnmpPDU) error { t.Fatal("unexpected callback"); return nil }, func([]string, uint8, uint32) (*gosnmp.SnmpPacket, error) { return nil, tt.err }, 10)
			if err == nil {
				t.Fatal("expected an error")
			}
			if tt.err != nil && !errors.Is(err, tt.err) {
				t.Fatalf("transport error lost: %v", err)
			}
		})
	}
}
