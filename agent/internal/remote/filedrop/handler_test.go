package filedrop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleStartUsesPrivateReceiveDirByDefault(t *testing.T) {
	handler := NewFileDropHandler(nil, "")

	if err := handler.handleStart(Message{
		Type:       MessageTypeDropStart,
		TransferID: "transfer-1",
		Name:       "report.txt",
		Size:       4,
	}); err != nil {
		t.Fatalf("handleStart returned error: %v", err)
	}
	defer handler.Close()

	transfer, ok := handler.transfers["transfer-1"]
	if !ok {
		t.Fatal("expected transfer to be registered")
	}

	if transfer.path == "" {
		t.Fatal("expected transfer path to be recorded")
	}
	if filepath.Dir(transfer.path) != handler.receiveDir {
		t.Fatalf("expected transfer path %q to be inside receive dir %q", transfer.path, handler.receiveDir)
	}
	if !strings.HasPrefix(filepath.Base(handler.receiveDir), "breeze-filedrop-") {
		t.Fatalf("expected generated receive dir name, got %q", handler.receiveDir)
	}

	info, err := os.Stat(transfer.path)
	if err != nil {
		t.Fatalf("stat transfer path: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected file mode 0600, got %o", info.Mode().Perm())
	}

	dirInfo, err := os.Stat(handler.receiveDir)
	if err != nil {
		t.Fatalf("stat receive dir: %v", err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("expected receive dir mode 0700, got %o", dirInfo.Mode().Perm())
	}
}

func TestHandleStartRejectsExistingTargetPath(t *testing.T) {
	receiveDir := t.TempDir()
	existingPath := filepath.Join(receiveDir, "report.txt")
	if err := os.WriteFile(existingPath, []byte("existing"), 0o600); err != nil {
		t.Fatalf("write existing file: %v", err)
	}

	handler := NewFileDropHandler(nil, receiveDir)
	defer handler.Close()

	err := handler.handleStart(Message{
		Type:       MessageTypeDropStart,
		TransferID: "transfer-1",
		Name:       "report.txt",
		Size:       4,
	})
	if err == nil {
		t.Fatal("expected handleStart to reject an existing target path")
	}
	if !os.IsExist(err) {
		t.Fatalf("expected os.IsExist error, got %v", err)
	}
}

func TestHandleCompleteRejectsIncompleteTransfer(t *testing.T) {
	handler := NewFileDropHandler(nil, t.TempDir())
	defer handler.Close()

	if err := handler.handleStart(Message{
		Type:       MessageTypeDropStart,
		TransferID: "transfer-1",
		Name:       "report.txt",
		Size:       4,
	}); err != nil {
		t.Fatalf("handleStart returned error: %v", err)
	}

	transfer := handler.transfers["transfer-1"]
	if transfer == nil {
		t.Fatal("expected transfer to exist")
	}

	err := handler.handleComplete(Message{
		Type:       MessageTypeDropComplete,
		TransferID: "transfer-1",
	})
	if err == nil {
		t.Fatal("expected incomplete transfer to be rejected")
	}
	if _, statErr := os.Stat(transfer.path); !os.IsNotExist(statErr) {
		t.Fatalf("expected incomplete transfer file to be removed, got %v", statErr)
	}
}

func TestHandleStartRejectsDuplicateTransferID(t *testing.T) {
	handler := NewFileDropHandler(nil, t.TempDir())
	defer handler.Close()

	if err := handler.handleStart(Message{
		Type:       MessageTypeDropStart,
		TransferID: "transfer-1",
		Name:       "report-1.txt",
		Size:       4,
	}); err != nil {
		t.Fatalf("first handleStart returned error: %v", err)
	}

	err := handler.handleStart(Message{
		Type:       MessageTypeDropStart,
		TransferID: "transfer-1",
		Name:       "report-2.txt",
		Size:       4,
	})
	if err == nil {
		t.Fatal("expected duplicate transfer id to be rejected")
	}
}

func TestHandleChunkRejectsOversizedPayload(t *testing.T) {
	handler := NewFileDropHandler(nil, t.TempDir())
	defer handler.Close()

	err := handler.handleChunk(Message{
		Type:       MessageTypeDropChunk,
		TransferID: "transfer-1",
		Offset:     0,
		Data:       strings.Repeat("A", maxBase64EncodedLen(maxChunkPayloadSize)+1),
	})
	if err == nil {
		t.Fatal("expected oversized chunk payload to be rejected")
	}
}
