package backup

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// attestationVector is one entry of testdata/attestation-vectors.json, the
// file the API's backupAttestation.test.ts reads too: both sides must agree
// on every byte of a statement.
type attestationVector struct {
	Name      string `json:"name"`
	Statement string `json:"statement"`
	Valid     bool   `json:"valid"`
	SHA256    string `json:"sha256"`
	Reason    string `json:"reason"`
}

func loadAttestationVectors(t *testing.T) []attestationVector {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "attestation-vectors.json"))
	if err != nil {
		t.Fatalf("read shared attestation vectors: %v", err)
	}
	var vectors []attestationVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode shared attestation vectors: %v", err)
	}
	if len(vectors) == 0 {
		t.Fatal("shared attestation vectors file is empty")
	}
	return vectors
}

// decodeStatementStrict decodes raw into the statement type, refusing
// unknown keys, as the encoder's round-trip counterpart.
func decodeStatementStrict(raw string) (AttestationStatement, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var s AttestationStatement
	err := dec.Decode(&s)
	return s, err
}

func TestAttestationVectorsValidStatementsRoundTripByteIdentical(t *testing.T) {
	valid := 0
	for _, v := range loadAttestationVectors(t) {
		if !v.Valid {
			continue
		}
		valid++
		t.Run(v.Name, func(t *testing.T) {
			s, err := decodeStatementStrict(v.Statement)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			got, err := EncodeAttestationStatement(s)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if got != v.Statement {
				t.Fatalf("encoding differs from the shared vector\n got: %s\nwant: %s", got, v.Statement)
			}
			sum := sha256.Sum256([]byte(got))
			if hex.EncodeToString(sum[:]) != v.SHA256 {
				t.Fatalf("sha256 = %x, want %s", sum, v.SHA256)
			}
			if StatementSHA256(got) != v.SHA256 {
				t.Fatalf("StatementSHA256 = %s, want %s", StatementSHA256(got), v.SHA256)
			}
		})
	}
	if valid < 4 {
		t.Fatalf("expected at least 4 valid vectors, found %d", valid)
	}
}

// Every statement the server refuses must be one this encoder can never
// produce: either the vector does not decode, the encoder refuses it, or the
// encoder's output differs from the refused bytes.
func TestAttestationVectorsInvalidStatementsNeverReproduced(t *testing.T) {
	invalid := 0
	for _, v := range loadAttestationVectors(t) {
		if v.Valid {
			continue
		}
		invalid++
		t.Run(v.Name, func(t *testing.T) {
			s, err := decodeStatementStrict(v.Statement)
			if err != nil {
				return
			}
			got, err := EncodeAttestationStatement(s)
			if err != nil {
				return
			}
			if got == v.Statement {
				t.Fatalf("encoder reproduced a statement the server refuses (%s): %s", v.Reason, got)
			}
		})
	}
	if invalid == 0 {
		t.Fatal("expected invalid vectors in the shared file")
	}
}

func testStatement() AttestationStatement {
	id := "snapshot-20261108T101500Z-3f9a1c7e2b4d6a8c0e1f2a3b"
	return AttestationStatement{
		V:          AttestationFormatVersion,
		SnapshotID: id,
		JobID:      "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35",
		AgentID:    "a1b2c3d4e5f60718293a4b5c6d7e8f90",
		KeyLayout:  AttestationKeyLayoutLegacyFlat,
		Objects: []PublishedObject{
			{Role: AttestationRoleSystemStateManifest, Key: "snapshots/" + id + "/system-state/manifest.json", SHA256: strings.Repeat("c", 64), Size: 4096},
			{Role: AttestationRoleManifest, Key: "snapshots/" + id + "/manifest.json", SHA256: strings.Repeat("a", 64), Size: 1234},
			{Role: AttestationRoleLayout, Key: "snapshots/" + id + "/layout.json", SHA256: strings.Repeat("b", 64), Size: 2048},
		},
	}
}

func TestEncodeAttestationStatementSortsObjectsByRole(t *testing.T) {
	got, err := EncodeAttestationStatement(testStatement())
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// Same content as the "full run with layout and system state" vector.
	for _, v := range loadAttestationVectors(t) {
		if v.Name == "full run with layout and system state" {
			if got != v.Statement {
				t.Fatalf("sorted encoding differs from the vector\n got: %s\nwant: %s", got, v.Statement)
			}
			return
		}
	}
	t.Fatal("vector \"full run with layout and system state\" not found")
}

func TestEncodeAttestationStatementRefusesInvalidStatements(t *testing.T) {
	base := "snapshot-20261108T101500Z-3f9a1c7e2b4d6a8c0e1f2a3b"
	other := "snapshot-20261107T101500Z-0a1b2c3d4e5f60718293a4b5"
	cases := []struct {
		name   string
		mutate func(*AttestationStatement)
	}{
		{"duplicate role", func(s *AttestationStatement) { s.Objects = append(s.Objects, s.Objects[1]) }},
		{"manifest missing", func(s *AttestationStatement) { s.Objects = s.Objects[:1] }},
		{"unknown role", func(s *AttestationStatement) { s.Objects[0].Role = "other" }},
		{"key does not match its role", func(s *AttestationStatement) { s.Objects[1].Key = "snapshots/" + base + "/layout.json" }},
		{"uppercase digest", func(s *AttestationStatement) { s.Objects[1].SHA256 = strings.Repeat("A", 64) }},
		{"short digest", func(s *AttestationStatement) { s.Objects[1].SHA256 = "abc" }},
		{"negative size", func(s *AttestationStatement) { s.Objects[1].Size = -1 }},
		{"format version 2", func(s *AttestationStatement) { s.V = 2 }},
		{"other key layout", func(s *AttestationStatement) { s.KeyLayout = "device_scoped" }},
		{"empty job id", func(s *AttestationStatement) { s.JobID = "" }},
		{"empty agent id", func(s *AttestationStatement) { s.AgentID = "" }},
		{"agent id with html-significant characters", func(s *AttestationStatement) { s.AgentID = "a<b>&c" }},
		{"agent id with a quote", func(s *AttestationStatement) { s.AgentID = `a"b` }},
		{"agent id with non-ascii", func(s *AttestationStatement) { s.AgentID = "agent id" }},
		{"snapshot id with a path separator", func(s *AttestationStatement) { s.SnapshotID = "../x" }},
		{"parent without a dispatched base", func(s *AttestationStatement) { s.ParentSnapshotID = &other }},
		{"parent differs from the dispatched base", func(s *AttestationStatement) {
			d := base + "-x"
			s.DispatchedBaseSnapshotID = &d
			s.ParentSnapshotID = &other
		}},
		{"oversized", func(s *AttestationStatement) { s.AgentID = strings.Repeat("a", 300) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := testStatement()
			tc.mutate(&s)
			if got, err := EncodeAttestationStatement(s); err == nil {
				t.Fatalf("expected refusal, got %s", got)
			}
		})
	}
}

func TestEncodeAttestationStatementDoesNotMutateInput(t *testing.T) {
	s := testStatement()
	before := s.Objects[0].Role
	if _, err := EncodeAttestationStatement(s); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if s.Objects[0].Role != before {
		t.Fatalf("input objects were reordered in place")
	}
}

func TestEncodeAttestationStatementHasNoTrailingNewline(t *testing.T) {
	got, err := EncodeAttestationStatement(testStatement())
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if bytes.HasSuffix([]byte(got), []byte("\n")) {
		t.Fatalf("statement ends with a newline")
	}
}
