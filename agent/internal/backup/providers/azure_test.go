package providers

import (
	"testing"
)

// Compile-time interface compliance checks.
var _ BackupProvider = (*AzureProvider)(nil)
var _ StreamUploader = (*AzureProvider)(nil)
var _ MetadataReader = (*AzureProvider)(nil)

func TestNewAzureProvider_EmptyAccountName(t *testing.T) {
	_, err := NewAzureProvider("", "key", "container")
	if err == nil {
		t.Fatal("expected error for empty account name")
	}
}

func TestNewAzureProvider_EmptyAccountKey(t *testing.T) {
	_, err := NewAzureProvider("account", "", "container")
	if err == nil {
		t.Fatal("expected error for empty account key")
	}
}

func TestNewAzureProvider_EmptyContainer(t *testing.T) {
	_, err := NewAzureProvider("account", "key", "")
	if err == nil {
		t.Fatal("expected error for empty container name")
	}
}

func TestNewAzureProvider_Valid(t *testing.T) {
	p, err := NewAzureProvider("account", "key", "container")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.containerName != "container" {
		t.Errorf("expected container 'container', got %q", p.containerName)
	}
}

func TestAzureProvider_UploadEmptyLocalPath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.Upload("", "remote/path")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestAzureProvider_UploadEmptyRemotePath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.Upload("/tmp/file.txt", "")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestAzureProvider_DownloadEmptyRemotePath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.Download("", "/tmp/file.txt")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestAzureProvider_DownloadEmptyLocalPath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.Download("remote/path", "")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestAzureProvider_DeleteEmptyRemotePath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.Delete("")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestAzureProvider_UploadStreamNilReader(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.UploadStream(nil, "remote/path", 100)
	if err == nil {
		t.Fatal("expected error for nil reader")
	}
}

func TestAzureProvider_UploadStreamEmptyRemotePath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	err := p.UploadStream(nil, "", 100)
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestAzureProvider_GetObjectMetadataEmptyPath(t *testing.T) {
	p, _ := NewAzureProvider("account", "key", "container")
	_, err := p.GetObjectMetadata("")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}
