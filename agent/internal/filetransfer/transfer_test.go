package filetransfer

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
