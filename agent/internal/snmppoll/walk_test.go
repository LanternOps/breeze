package snmppoll

import (
	"strings"
	"testing"
)

func TestBulkWalk_EmptyOIDReturnsError(t *testing.T) {
	_, err := (&SNMPClient{}).BulkWalk("")
	if err == nil {
		t.Fatal("BulkWalk(\"\") = nil error, want non-nil")
	}
	if !strings.Contains(err.Error(), "oid is required") {
		t.Errorf("BulkWalk(\"\") error = %q, want it to contain %q", err.Error(), "oid is required")
	}
}

func TestBulkWalk_NilClientReturnsError(t *testing.T) {
	_, err := (&SNMPClient{client: nil}).BulkWalk("1.3.6")
	if err == nil {
		t.Fatal("BulkWalk with nil client = nil error, want non-nil")
	}
}
