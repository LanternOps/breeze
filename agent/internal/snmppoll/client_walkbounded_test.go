package snmppoll

import (
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
