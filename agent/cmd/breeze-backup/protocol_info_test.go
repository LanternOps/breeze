package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/storagesession"
)

// TestPrintProtocolInfoReportsAllProtocols: --protocol-info names every
// storage protocol this build implements, including the ones at 0, so the
// main agent can tell "implements none" apart from "predates the field".
func TestPrintProtocolInfoReportsAllProtocols(t *testing.T) {
	var buf bytes.Buffer
	if err := printProtocolInfo(&buf); err != nil {
		t.Fatal(err)
	}
	var got map[string]int
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("output %q is not a JSON object of integers: %v", buf.String(), err)
	}
	for _, k := range []string{"backupReadProtocolVersion", "backupIntegrityProtocolVersion", "backupWriteProtocolVersion"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("missing %s in %s", k, buf.String())
		}
	}
	if len(got) != 3 {
		t.Fatalf("unexpected keys in %s", buf.String())
	}
	if got["backupReadProtocolVersion"] != storagesession.ProtocolVersion {
		t.Fatalf("read = %d, want %d", got["backupReadProtocolVersion"], storagesession.ProtocolVersion)
	}
	if got["backupIntegrityProtocolVersion"] != backup.IntegrityProtocolVersion {
		t.Fatalf("integrity = %d, want %d", got["backupIntegrityProtocolVersion"], backup.IntegrityProtocolVersion)
	}
	if got["backupWriteProtocolVersion"] != storagesession.WriteProtocolVersion {
		t.Fatalf("write = %d, want %d", got["backupWriteProtocolVersion"], storagesession.WriteProtocolVersion)
	}
}

// TestProtocolVersionsThisBuildImplements pins the values this build
// reports: brokered reads, integrity protocol 1 (snapshot attestations
// plus a verified incremental base) and write protocol 1 (backups to S3
// through a write-scoped storage session, under the server-issued snapshot
// id). Raising a value is what tells the server the helper implements that
// protocol.
func TestProtocolVersionsThisBuildImplements(t *testing.T) {
	if backup.IntegrityProtocolVersion != 1 {
		t.Fatalf("IntegrityProtocolVersion = %d, want 1", backup.IntegrityProtocolVersion)
	}
	if storagesession.WriteProtocolVersion != 1 {
		t.Fatalf("WriteProtocolVersion = %d, want 1", storagesession.WriteProtocolVersion)
	}
}
