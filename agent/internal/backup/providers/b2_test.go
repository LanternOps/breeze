package providers

import (
	"testing"
)

// Compile-time interface compliance check.
var _ BackupProvider = (*B2Provider)(nil)

func TestNewB2Provider_EmptyKeyID(t *testing.T) {
	_, err := NewB2Provider("", "appkey", "bucket")
	if err == nil {
		t.Fatal("expected error for empty key ID")
	}
}

func TestNewB2Provider_EmptyAppKey(t *testing.T) {
	_, err := NewB2Provider("keyid", "", "bucket")
	if err == nil {
		t.Fatal("expected error for empty application key")
	}
}

func TestNewB2Provider_EmptyBucket(t *testing.T) {
	_, err := NewB2Provider("keyid", "appkey", "")
	if err == nil {
		t.Fatal("expected error for empty bucket name")
	}
}

func TestNewB2Provider_Valid(t *testing.T) {
	p, err := NewB2Provider("keyid", "appkey", "bucket")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.bucketName != "bucket" {
		t.Errorf("expected bucket 'bucket', got %q", p.bucketName)
	}
}

func TestB2Provider_UploadEmptyLocalPath(t *testing.T) {
	p, _ := NewB2Provider("keyid", "appkey", "bucket")
	err := p.Upload("", "remote/path")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestB2Provider_UploadEmptyRemotePath(t *testing.T) {
	p, _ := NewB2Provider("keyid", "appkey", "bucket")
	err := p.Upload("/tmp/file.txt", "")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestB2Provider_DownloadEmptyRemotePath(t *testing.T) {
	p, _ := NewB2Provider("keyid", "appkey", "bucket")
	err := p.Download("", "/tmp/file.txt")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestB2Provider_DownloadEmptyLocalPath(t *testing.T) {
	p, _ := NewB2Provider("keyid", "appkey", "bucket")
	err := p.Download("remote/path", "")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestB2Provider_DeleteEmptyRemotePath(t *testing.T) {
	p, _ := NewB2Provider("keyid", "appkey", "bucket")
	err := p.Delete("")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}
