package filetransfer

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// ---------- HandleTransfer — download flow ----------

func TestHandleTransferDownloadSuccess(t *testing.T) {
	body := "downloaded-content"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer dl-token" {
			t.Errorf("expected Bearer dl-token, got %q", auth)
		}

		if r.Method == "GET" {
			w.Header().Set("Content-Length", "18")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(body))
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	destFile := filepath.Join(tmpDir, "subdir", "output.txt")

	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("dl-token"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	result := m.HandleTransfer(map[string]any{
		"transferId": "t-dl-1",
		"direction":  "download",
		"remotePath": "/remote/file.txt",
		"localPath":  destFile,
	})

	if result["status"] != "completed" {
		t.Fatalf("expected completed, got %v (error: %v)", result["status"], result["error"])
	}

	// Verify file was written
	data, err := os.ReadFile(destFile)
	if err != nil {
		t.Fatalf("failed to read downloaded file: %v", err)
	}
	if string(data) != body {
		t.Fatalf("expected %q, got %q", body, string(data))
	}
}

func TestHandleTransferDownloadDirectoryTraversal(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	result := m.HandleTransfer(map[string]any{
		"transferId": "t-dl-traversal",
		"direction":  "download",
		"remotePath": "/remote/file.txt",
		"localPath":  "/safe/../../etc/shadow",
	})

	if result["status"] != "failed" {
		t.Fatalf("expected failed for traversal, got %v", result["status"])
	}
}

func TestHandleTransferDownloadServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.WriteHeader(http.StatusInternalServerError)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	result := m.HandleTransfer(map[string]any{
		"transferId": "t-dl-500",
		"direction":  "download",
		"remotePath": "/remote/file.txt",
		"localPath":  filepath.Join(tmpDir, "out.txt"),
	})

	if result["status"] != "failed" {
		t.Fatalf("expected failed, got %v", result["status"])
	}
}

// ---------- CancelTransfer ----------

func TestCancelTransferSetsStatus(t *testing.T) {
	cfg := &Config{
		ServerURL: "https://example.com",
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	// Pre-populate a transfer
	m.transfers["cancel-me"] = &Transfer{
		ID:     "cancel-me",
		Status: "transferring",
	}

	m.CancelTransfer("cancel-me")

	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.transfers["cancel-me"].Status != "cancelled" {
		t.Fatalf("expected cancelled, got %s", m.transfers["cancel-me"].Status)
	}
}

func TestCancelTransferNonexistentIsNoop(t *testing.T) {
	cfg := &Config{
		ServerURL: "https://example.com",
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	// Should not panic
	m.CancelTransfer("does-not-exist")
}

// ---------- Concurrency safety ----------

func TestConcurrentHandleTransfer(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	// Create multiple files and run transfers concurrently
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			srcFile := filepath.Join(tmpDir, filepath.Base(t.Name())+"_"+string(rune('a'+idx))+".txt")
			os.WriteFile(srcFile, []byte("data"), 0644)
			m.HandleTransfer(map[string]any{
				"transferId": "concurrent-" + string(rune('a'+idx)),
				"direction":  "upload",
				"remotePath": srcFile,
				"localPath":  "/remote/dest",
			})
		}(i)
	}
	wg.Wait()
}

// ---------- reportProgress ----------

func TestReportProgressSendsJSON(t *testing.T) {
	var receivedBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			body, _ := io.ReadAll(r.Body)
			json.Unmarshal(body, &receivedBody)
			if r.Header.Get("Content-Type") != "application/json" {
				t.Errorf("expected application/json content type, got %q", r.Header.Get("Content-Type"))
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	transfer := &Transfer{
		ID:       "progress-test",
		Status:   "transferring",
		Progress: 42,
		Error:    "",
	}
	m.reportProgress(transfer)

	if receivedBody == nil {
		t.Fatal("no body received by server")
	}
	if receivedBody["transferId"] != "progress-test" {
		t.Fatalf("expected transferId=progress-test, got %v", receivedBody["transferId"])
	}
	if receivedBody["status"] != "transferring" {
		t.Fatalf("expected status=transferring, got %v", receivedBody["status"])
	}
	// JSON numbers decode as float64
	if receivedBody["progress"].(float64) != 42 {
		t.Fatalf("expected progress=42, got %v", receivedBody["progress"])
	}
}

// ---------- ChunkSize constant ----------

func TestChunkSizeIs1MB(t *testing.T) {
	if ChunkSize != 1*1024*1024 {
		t.Fatalf("ChunkSize = %d, want %d", ChunkSize, 1*1024*1024)
	}
}

// ---------- Transfer with unknown direction ----------

func TestHandleTransferUnknownDirection(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Download endpoint returns 404 since we're using an invalid direction
		// that falls through to the download path
		if r.Method == "GET" {
			w.WriteHeader(http.StatusNotFound)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	// Unknown direction falls to "download" path, which will fail creating directory/downloading
	result := m.HandleTransfer(map[string]any{
		"transferId": "t-unknown-dir",
		"direction":  "foobar",
		"remotePath": "/remote/file.txt",
		"localPath":  filepath.Join(tmpDir, "out.txt"),
	})

	// Should fail because the download endpoint returns 404
	if result["status"] != "failed" {
		t.Fatalf("expected failed for unknown direction with 404, got %v", result["status"])
	}
}
