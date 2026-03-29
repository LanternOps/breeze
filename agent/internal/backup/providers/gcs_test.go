package providers

import (
	"testing"
)

// Compile-time interface compliance checks.
var _ BackupProvider = (*GCSProvider)(nil)
var _ StreamUploader = (*GCSProvider)(nil)
var _ MetadataReader = (*GCSProvider)(nil)

func TestNewGCSProvider_EmptyBucket(t *testing.T) {
	_, err := NewGCSProvider("", nil)
	if err == nil {
		t.Fatal("expected error for empty bucket name")
	}
}

func TestNewGCSProvider_ValidWithNilCredentials(t *testing.T) {
	p, err := NewGCSProvider("my-bucket", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.bucketName != "my-bucket" {
		t.Errorf("expected bucket 'my-bucket', got %q", p.bucketName)
	}
	if p.credentialsJSON != nil {
		t.Error("expected nil credentials")
	}
}

func TestNewGCSProvider_ValidWithCredentials(t *testing.T) {
	creds := []byte(`{"type":"service_account"}`)
	p, err := NewGCSProvider("my-bucket", creds)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.credentialsJSON == nil {
		t.Error("expected credentials to be set")
	}
}

func TestGCSProvider_UploadEmptyLocalPath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.Upload("", "remote/path")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestGCSProvider_UploadEmptyRemotePath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.Upload("/tmp/file.txt", "")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestGCSProvider_DownloadEmptyRemotePath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.Download("", "/tmp/file.txt")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestGCSProvider_DownloadEmptyLocalPath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.Download("remote/path", "")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestGCSProvider_DeleteEmptyRemotePath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.Delete("")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestGCSProvider_UploadStreamNilReader(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.UploadStream(nil, "remote/path", 100)
	if err == nil {
		t.Fatal("expected error for nil reader")
	}
}

func TestGCSProvider_UploadStreamEmptyRemotePath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	err := p.UploadStream(nil, "", 100)
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestGCSProvider_GetObjectMetadataEmptyPath(t *testing.T) {
	p, _ := NewGCSProvider("bucket", nil)
	_, err := p.GetObjectMetadata("")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}
