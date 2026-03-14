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

// ---------- NewManager ----------

func TestNewManagerInitializesFields(t *testing.T) {
	cfg := &Config{
		ServerURL: "https://example.com",
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	if m.config != cfg {
		t.Fatal("config not assigned")
	}
	if m.client == nil {
		t.Fatal("http client is nil")
	}
	if m.transfers == nil {
		t.Fatal("transfers map is nil")
	}
}

// ---------- HandleTransfer — validation ----------

func TestHandleTransferMissingFieldsReturnsError(t *testing.T) {
	cfg := &Config{
		ServerURL: "https://example.com",
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	tests := []struct {
		name    string
		payload map[string]any
	}{
		{"missing transferId", map[string]any{"direction": "upload", "remotePath": "/tmp/a"}},
		{"missing direction", map[string]any{"transferId": "t1", "remotePath": "/tmp/a"}},
		{"missing remotePath", map[string]any{"transferId": "t1", "direction": "upload"}},
		{"all empty", map[string]any{}},
		{"nil values", map[string]any{"transferId": nil, "direction": nil, "remotePath": nil}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := m.HandleTransfer(tt.payload)
			if result["status"] != "failed" {
				t.Fatalf("expected status=failed, got %v", result["status"])
			}
			if result["error"] != "missing required fields" {
				t.Fatalf("expected 'missing required fields', got %v", result["error"])
			}
		})
	}
}

// ---------- HandleTransfer — upload flow ----------

func TestHandleTransferUploadSuccess(t *testing.T) {
	// Create a temporary file to upload
	tmpDir := t.TempDir()
	srcFile := filepath.Join(tmpDir, "test.txt")
	content := "hello world"
	if err := os.WriteFile(srcFile, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	var chunkCount int
	var progressReports int

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify auth header
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			t.Errorf("expected Bearer test-token, got %q", auth)
		}

		if r.Method == "POST" {
			chunkCount++
			w.WriteHeader(http.StatusOK)
		} else if r.Method == "PUT" {
			progressReports++
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()

	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("test-token"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	result := m.HandleTransfer(map[string]any{
		"transferId": "t-upload-1",
		"direction":  "upload",
		"remotePath": srcFile, // upload reads from remotePath
		"localPath":  "/remote/dest.txt",
	})

	if result["status"] != "completed" {
		t.Fatalf("expected completed, got %v (error: %v)", result["status"], result["error"])
	}
	if result["transferId"] != "t-upload-1" {
		t.Fatalf("expected transferId=t-upload-1, got %v", result["transferId"])
	}
	if chunkCount == 0 {
		t.Fatal("expected at least one chunk upload")
	}
	if progressReports == 0 {
		t.Fatal("expected at least one progress report")
	}
}

func TestHandleTransferUploadDirectoryTraversal(t *testing.T) {
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
		"transferId": "t-traversal",
		"direction":  "upload",
		"remotePath": "/safe/../../../etc/passwd",
		"localPath":  "/tmp/out",
	})

	if result["status"] != "failed" {
		t.Fatalf("expected failed for traversal, got %v", result["status"])
	}
}

func TestHandleTransferUploadNonexistentFile(t *testing.T) {
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
		"transferId": "t-nofile",
		"direction":  "upload",
		"remotePath": "/nonexistent/file/path.txt",
		"localPath":  "/tmp/out",
	})

	if result["status"] != "failed" {
		t.Fatalf("expected failed, got %v", result["status"])
	}
	errStr, _ := result["error"].(string)
	if errStr == "" {
		t.Fatal("expected non-empty error message")
	}
}

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

// ---------- HandleTransfer — upload server error ----------

func TestHandleTransferUploadChunkServerError(t *testing.T) {
	tmpDir := t.TempDir()
	srcFile := filepath.Join(tmpDir, "src.txt")
	if err := os.WriteFile(srcFile, []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.WriteHeader(http.StatusInternalServerError)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()

	cfg := &Config{
		ServerURL: ts.URL,
		AuthToken: secmem.NewSecureString("tok"),
		AgentID:   "agent-1",
	}
	m := NewManager(cfg)

	result := m.HandleTransfer(map[string]any{
		"transferId": "t-upload-fail",
		"direction":  "upload",
		"remotePath": srcFile,
		"localPath":  "/remote/dest.txt",
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

// ---------- Multi-chunk upload ----------

func TestHandleTransferUploadMultipleChunks(t *testing.T) {
	tmpDir := t.TempDir()
	srcFile := filepath.Join(tmpDir, "bigfile.dat")

	// Create a file just over 1 chunk in size (ChunkSize + 100 bytes)
	data := make([]byte, ChunkSize+100)
	for i := range data {
		data[i] = byte(i % 256)
	}
	if err := os.WriteFile(srcFile, data, 0644); err != nil {
		t.Fatal(err)
	}

	var chunkCount int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			chunkCount++
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

	result := m.HandleTransfer(map[string]any{
		"transferId": "t-multi-chunk",
		"direction":  "upload",
		"remotePath": srcFile,
		"localPath":  "/remote/dest.dat",
	})

	if result["status"] != "completed" {
		t.Fatalf("expected completed, got %v (error: %v)", result["status"], result["error"])
	}
	if chunkCount < 2 {
		t.Fatalf("expected at least 2 chunks, got %d", chunkCount)
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
