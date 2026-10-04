package tools

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

// The same vector is read by apps/api/src/services/diagnosticAccess/interop.test.ts:
// the API must produce these exact canonical bytes, and must open this exact
// agent-sealed result.
type diagInteropVector struct {
	AuthorizationVector struct {
		PublicKey     string         `json:"publicKey"`
		Authorization map[string]any `json:"authorization"`
		CanonicalB64  string         `json:"canonicalB64"`
	} `json:"authorizationVector"`
	SealVector struct {
		ServerPrivateKey string           `json:"serverPrivateKey"`
		Sealed           DiagSealedResult `json:"sealed"`
		Plaintext        map[string]any   `json:"plaintext"`
	} `json:"sealVector"`
}

func loadDiagInteropVector(t *testing.T) diagInteropVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/diagnostic_interop_vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v diagInteropVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestDiagInteropAPISignedAuthorizationVerifiesOnAgent(t *testing.T) {
	v := loadDiagInteropVector(t)
	auth, present, err := ParseDiagnosticAuthorization(map[string]any{DiagnosticAuthorizationPayloadKey: v.AuthorizationVector.Authorization})
	if err != nil || !present {
		t.Fatalf("parse: present=%v err=%v", present, err)
	}
	canonical, err := auth.CanonicalBytes()
	if err != nil {
		t.Fatal(err)
	}
	want, _ := base64.StdEncoding.DecodeString(v.AuthorizationVector.CanonicalB64)
	if !bytes.Equal(canonical, want) {
		t.Fatalf("canonical bytes differ from the API's\n got: %q\nwant: %q", canonical, want)
	}
	pub, _ := base64.StdEncoding.DecodeString(v.AuthorizationVector.PublicKey)
	env := DiagGrantEnv{
		DeviceID: auth.DeviceID,
		OrgID:    auth.OrgID,
		Verify: func(keyID string, payload, sig []byte) error {
			if keyID != "test-key-1" || !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
				return errors.New("bad signature")
			}
			return nil
		},
		Now: func() time.Time { return time.Date(2026, 9, 28, 17, 1, 0, 0, time.UTC) },
	}
	args := DiagCommandArgs{
		CommandID:       auth.CommandID,
		Path:            auth.RequestPath,
		Offset:          4096,
		MaxBytes:        65536,
		Encoding:        "text",
		ResultPublicKey: auth.ResultPublicKey,
	}
	if err := VerifyDiagnosticAuthorization(auth, env, "read", args); err != nil {
		t.Fatalf("API-signed authorization rejected: %v", err)
	}
}

func TestDiagInteropSealedVectorOpensWithServerKey(t *testing.T) {
	v := loadDiagInteropVector(t)
	rawPriv, _ := base64.StdEncoding.DecodeString(v.SealVector.ServerPrivateKey)
	priv, err := ecdh.X25519().NewPrivateKey(rawPriv)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := openDiagResult(priv, &v.SealVector.Sealed)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(plain, &got); err != nil {
		t.Fatal(err)
	}
	if got["content"] != v.SealVector.Plaintext["content"] {
		t.Fatalf("content mismatch: %v", got["content"])
	}
}
