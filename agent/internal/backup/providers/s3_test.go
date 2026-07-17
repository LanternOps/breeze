package providers

import "testing"

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
