package providers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// Compile-time interface compliance check.
var _ JournalIdentity = (*S3Provider)(nil)

func TestS3Provider_BackupIdentity(t *testing.T) {
	a := NewS3Provider("bucket-a", "us-east-1", "key", "secret", "")
	b := NewS3Provider("bucket-b", "us-east-1", "key", "secret", "")
	if a.BackupIdentity() == b.BackupIdentity() {
		t.Fatal("different buckets must produce different identities")
	}

	sameBucketDifferentCreds := NewS3Provider("bucket-a", "us-east-1", "other-key", "other-secret", "other-token")
	if a.BackupIdentity() != sameBucketDifferentCreds.BackupIdentity() {
		t.Error("identity must not depend on credentials")
	}
}

func TestS3Provider_BackupIdentity_EndpointDistinguishesDestination(t *testing.T) {
	// Same bucket+region but different (or absent) endpoint means a
	// different S3-compatible backend (MinIO, Backblaze's S3 API, ...) —
	// the identity must not collide.
	standard := NewS3ProviderWithEndpoint("bucket", "us-east-1", "", "key", "secret", "")
	custom := NewS3ProviderWithEndpoint("bucket", "us-east-1", "https://minio.example.com", "key", "secret", "")
	if standard.BackupIdentity() == custom.BackupIdentity() {
		t.Fatal("different endpoints must produce different identities")
	}
}

// TestS3Provider_Download_NoSuchKeyWrapsErrObjectNotFound uses a minimal
// httptest S3-compatible endpoint returning the standard NoSuchKey XML error
// (no existing fake S3 backend for Download exists in this package's tests
// today), proving Download positively confirms absence via
// providers.ErrObjectNotFound — never merely "some error happened".
func TestS3Provider_Download_NoSuchKeyWrapsErrObjectNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>snapshots/missing/manifest.json</Key>
  <RequestId>test-request-id</RequestId>
</Error>`))
	}))
	defer server.Close()

	provider := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	err := provider.Download("snapshots/missing/manifest.json", filepath.Join(t.TempDir(), "out.json"))
	if err == nil {
		t.Fatal("expected an error for a missing s3 object")
	}
	if !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("err = %v, want it to wrap ErrObjectNotFound", err)
	}
}
