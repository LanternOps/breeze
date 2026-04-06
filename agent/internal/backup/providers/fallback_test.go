package providers

import (
	"errors"
	"testing"
)

// mockProvider is a simple in-memory BackupProvider for testing.
type mockProvider struct {
	files     map[string]string // remotePath -> content (simulated)
	uploadErr error
	downloadErr error
	listErr   error
	deleteErr error
	uploads   []string // track upload calls
	downloads []string // track download calls
	deletes   []string // track delete calls
}

func newMockProvider() *mockProvider {
	return &mockProvider{files: make(map[string]string)}
}

func (m *mockProvider) Upload(localPath, remotePath string) error {
	m.uploads = append(m.uploads, remotePath)
	if m.uploadErr != nil {
		return m.uploadErr
	}
	m.files[remotePath] = localPath
	return nil
}

func (m *mockProvider) Download(remotePath, localPath string) error {
	m.downloads = append(m.downloads, remotePath)
	if m.downloadErr != nil {
		return m.downloadErr
	}
	if _, ok := m.files[remotePath]; !ok {
		return errors.New("file not found: " + remotePath)
	}
	return nil
}

func (m *mockProvider) List(prefix string) ([]string, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	var result []string
	for k := range m.files {
		result = append(result, k)
	}
	return result, nil
}

func (m *mockProvider) Delete(remotePath string) error {
	m.deletes = append(m.deletes, remotePath)
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.files, remotePath)
	return nil
}

func TestFallbackDownload_PrimarySucceeds(t *testing.T) {
	primary := newMockProvider()
	primary.files["test/file.txt"] = "data"
	secondary := newMockProvider()

	fb := NewFallbackProvider(primary, secondary)
	err := fb.Download("test/file.txt", "/tmp/out.txt")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(primary.downloads) != 1 {
		t.Errorf("expected 1 primary download call, got %d", len(primary.downloads))
	}
	if len(secondary.downloads) != 0 {
		t.Errorf("expected 0 secondary download calls, got %d", len(secondary.downloads))
	}
}

func TestFallbackDownload_FallsBackToSecondary(t *testing.T) {
	primary := newMockProvider()
	primary.downloadErr = errors.New("primary offline")

	secondary := newMockProvider()
	secondary.files["test/file.txt"] = "data"

	fb := NewFallbackProvider(primary, secondary)
	err := fb.Download("test/file.txt", "/tmp/out.txt")
	if err != nil {
		t.Fatalf("expected no error from secondary, got %v", err)
	}

	if len(primary.downloads) != 1 {
		t.Errorf("expected 1 primary download call, got %d", len(primary.downloads))
	}
	if len(secondary.downloads) != 1 {
		t.Errorf("expected 1 secondary download call, got %d", len(secondary.downloads))
	}
}

func TestFallbackDownload_AllFail(t *testing.T) {
	primary := newMockProvider()
	primary.downloadErr = errors.New("primary offline")

	secondary := newMockProvider()
	secondary.downloadErr = errors.New("secondary offline")

	fb := NewFallbackProvider(primary, secondary)
	err := fb.Download("test/file.txt", "/tmp/out.txt")
	if err == nil {
		t.Fatal("expected error when all providers fail")
	}
}

func TestFallbackUpload_OnlyGoesToPrimary(t *testing.T) {
	primary := newMockProvider()
	secondary := newMockProvider()

	fb := NewFallbackProvider(primary, secondary)
	err := fb.Upload("/tmp/local.txt", "remote/file.txt")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(primary.uploads) != 1 {
		t.Errorf("expected 1 primary upload call, got %d", len(primary.uploads))
	}
	if len(secondary.uploads) != 0 {
		t.Errorf("expected 0 secondary upload calls, got %d", len(secondary.uploads))
	}
}

func TestFallbackDelete_GoesToAll(t *testing.T) {
	primary := newMockProvider()
	primary.files["test/file.txt"] = "data"
	secondary := newMockProvider()
	secondary.files["test/file.txt"] = "data"
	third := newMockProvider()
	third.files["test/file.txt"] = "data"

	fb := NewFallbackProvider(primary, secondary, third)
	err := fb.Delete("test/file.txt")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(primary.deletes) != 1 {
		t.Errorf("expected 1 primary delete call, got %d", len(primary.deletes))
	}
	if len(secondary.deletes) != 1 {
		t.Errorf("expected 1 secondary delete call, got %d", len(secondary.deletes))
	}
	if len(third.deletes) != 1 {
		t.Errorf("expected 1 third delete call, got %d", len(third.deletes))
	}
}

func TestFallbackDelete_PartialFailure(t *testing.T) {
	primary := newMockProvider()
	primary.files["test/file.txt"] = "data"

	secondary := newMockProvider()
	secondary.deleteErr = errors.New("secondary delete failed")

	fb := NewFallbackProvider(primary, secondary)
	err := fb.Delete("test/file.txt")
	if err == nil {
		t.Fatal("expected error from partial delete failure")
	}

	// Primary should still have been called and succeeded
	if len(primary.deletes) != 1 {
		t.Errorf("expected 1 primary delete, got %d", len(primary.deletes))
	}
	if len(secondary.deletes) != 1 {
		t.Errorf("expected 1 secondary delete, got %d", len(secondary.deletes))
	}
}

func TestFallbackList_UsesFirstProvider(t *testing.T) {
	primary := newMockProvider()
	primary.files["a.txt"] = "data"
	primary.files["b.txt"] = "data"

	secondary := newMockProvider()
	secondary.files["c.txt"] = "data"

	fb := NewFallbackProvider(primary, secondary)
	items, err := fb.List("")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(items) != 2 {
		t.Errorf("expected 2 items from primary, got %d", len(items))
	}
}

func TestFallbackNoProviders(t *testing.T) {
	fb := NewFallbackProvider()

	if err := fb.Upload("a", "b"); err == nil {
		t.Error("expected error on upload with no providers")
	}
	if err := fb.Download("a", "b"); err == nil {
		t.Error("expected error on download with no providers")
	}
	if _, err := fb.List(""); err == nil {
		t.Error("expected error on list with no providers")
	}
	if err := fb.Delete("a"); err == nil {
		t.Error("expected error on delete with no providers")
	}
}
