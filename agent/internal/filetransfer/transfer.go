package filetransfer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	ChunkSize = 1 * 1024 * 1024 // 1MB chunks
)

// Config holds file transfer configuration
type Config struct {
	ServerURL string
	AuthToken string
	AgentID   string
}

// Transfer represents an active file transfer
type Transfer struct {
	ID        string
	Direction string // "upload" or "download"
	LocalPath string
	RemotePath string
	Status    string
	Progress  int
	Error     string
}

// Manager handles file transfers
type Manager struct {
	config    *Config
	client    *http.Client
	transfers map[string]*Transfer
	mu        sync.RWMutex
}

// NewManager creates a new file transfer manager
func NewManager(cfg *Config) *Manager {
	return &Manager{
		config:    cfg,
		client:    &http.Client{Timeout: 5 * time.Minute},
		transfers: make(map[string]*Transfer),
	}
}

// HandleTransfer processes a file transfer command
func (m *Manager) HandleTransfer(payload map[string]any) map[string]any {
	transferID, _ := payload["transferId"].(string)
	direction, _ := payload["direction"].(string)
	remotePath, _ := payload["remotePath"].(string)
	localPath, _ := payload["localPath"].(string)

	if transferID == "" || direction == "" || remotePath == "" {
		return map[string]any{
			"status": "failed",
			"error":  "missing required fields",
		}
	}

	// Create transfer record
	transfer := &Transfer{
		ID:         transferID,
		Direction:  direction,
		LocalPath:  localPath,
		RemotePath: remotePath,
		Status:     "transferring",
	}

	m.mu.Lock()
	m.transfers[transferID] = transfer
	m.mu.Unlock()

	// Process transfer
	var err error
	if direction == "upload" {
		err = m.upload(transfer)
	} else {
		err = m.download(transfer)
	}

	if err != nil {
		transfer.Status = "failed"
		transfer.Error = err.Error()
		m.reportProgress(transfer)
		return map[string]any{
			"status": "failed",
			"error":  err.Error(),
		}
	}

	transfer.Status = "completed"
	transfer.Progress = 100
	m.reportProgress(transfer)

	return map[string]any{
		"status":     "completed",
		"transferId": transferID,
	}
}

// CancelTransfer cancels an active transfer
func (m *Manager) CancelTransfer(transferID string) {
	m.mu.Lock()
	if transfer, ok := m.transfers[transferID]; ok {
		transfer.Status = "cancelled"
	}
	m.mu.Unlock()
}

func (m *Manager) upload(transfer *Transfer) error {
	// Validate path - prevent directory traversal
	cleanPath := filepath.Clean(transfer.RemotePath)
	if strings.Contains(cleanPath, "..") {
		return fmt.Errorf("invalid path: directory traversal not allowed")
	}

	file, err := os.Open(transfer.RemotePath)
	if err != nil {
		return fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat file: %w", err)
	}

	totalSize := stat.Size()
	var uploaded int64

	// Read and upload in chunks
	buffer := make([]byte, ChunkSize)
	chunkNum := 0

	for {
		// Check if cancelled
		m.mu.RLock()
		if transfer.Status == "cancelled" {
			m.mu.RUnlock()
			return fmt.Errorf("transfer cancelled")
		}
		m.mu.RUnlock()

		n, err := file.Read(buffer)
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read file: %w", err)
		}

		// Upload chunk
		if err := m.uploadChunk(transfer.ID, chunkNum, buffer[:n], chunkNum == 0, n < ChunkSize); err != nil {
			return err
		}

		uploaded += int64(n)
		transfer.Progress = int((uploaded * 100) / totalSize)
		m.reportProgress(transfer)
		chunkNum++
	}

	return nil
}

func (m *Manager) uploadChunk(transferID string, chunkNum int, data []byte, isFirst, isLast bool) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	writer.WriteField("transferId", transferID)
	writer.WriteField("chunkNum", fmt.Sprintf("%d", chunkNum))
	writer.WriteField("isFirst", fmt.Sprintf("%t", isFirst))
	writer.WriteField("isLast", fmt.Sprintf("%t", isLast))

	part, err := writer.CreateFormFile("chunk", "chunk")
	if err != nil {
		return err
	}
	part.Write(data)
	writer.Close()

	url := fmt.Sprintf("%s/api/v1/remote/transfers/%s/chunks", m.config.ServerURL, transferID)
	req, err := http.NewRequest("POST", url, &body)
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+m.config.AuthToken)

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upload chunk failed with status %d", resp.StatusCode)
	}

	return nil
}

func (m *Manager) download(transfer *Transfer) error {
	// Validate destination path
	cleanPath := filepath.Clean(transfer.LocalPath)
	if strings.Contains(cleanPath, "..") {
		return fmt.Errorf("invalid path: directory traversal not allowed")
	}

	// Create destination directory if needed
	dir := filepath.Dir(transfer.LocalPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Download file
	url := fmt.Sprintf("%s/api/v1/remote/transfers/%s/download", m.config.ServerURL, transfer.ID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.config.AuthToken)

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with status %d", resp.StatusCode)
	}

	// Create output file
	file, err := os.Create(transfer.LocalPath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer file.Close()

	// Copy with progress
	totalSize := resp.ContentLength
	var downloaded int64
	buffer := make([]byte, ChunkSize)

	for {
		m.mu.RLock()
		if transfer.Status == "cancelled" {
			m.mu.RUnlock()
			return fmt.Errorf("transfer cancelled")
		}
		m.mu.RUnlock()

		n, err := resp.Body.Read(buffer)
		if n > 0 {
			if _, writeErr := file.Write(buffer[:n]); writeErr != nil {
				return fmt.Errorf("failed to write file: %w", writeErr)
			}
			downloaded += int64(n)
			if totalSize > 0 {
				transfer.Progress = int((downloaded * 100) / totalSize)
				m.reportProgress(transfer)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read response: %w", err)
		}
	}

	return nil
}

func (m *Manager) reportProgress(transfer *Transfer) {
	data := map[string]any{
		"transferId": transfer.ID,
		"status":     transfer.Status,
		"progress":   transfer.Progress,
		"error":      transfer.Error,
	}

	body, _ := json.Marshal(data)
	url := fmt.Sprintf("%s/api/v1/remote/transfers/%s/progress", m.config.ServerURL, transfer.ID)

	req, _ := http.NewRequest("PUT", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+m.config.AuthToken)

	m.client.Do(req)
}
