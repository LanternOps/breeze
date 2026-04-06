package filedrop

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pion/webrtc/v4"
)

const (
	defaultChunkSize       = 64 * 1024
	maxChunkPayloadSize    = 1 * 1024 * 1024
	maxTransferSize        = 500 * 1024 * 1024 // 500MB max file transfer
	maxConcurrentTransfers = 8
)

type ReceivedFile struct {
	TransferID string
	Name       string
	Path       string
	Size       int64
}

type FileDropHandler struct {
	dc         *webrtc.DataChannel
	chunkSize  int
	receiveDir string

	mu        sync.Mutex
	transfers map[string]*incomingTransfer
	completed chan ReceivedFile
	closed    bool
}

type incomingTransfer struct {
	name     string
	path     string
	size     int64
	received int64
	file     *os.File
}

func NewFileDropHandler(dc *webrtc.DataChannel, receiveDir string) *FileDropHandler {
	handler := &FileDropHandler{
		dc:         dc,
		chunkSize:  defaultChunkSize,
		receiveDir: receiveDir,
		transfers:  make(map[string]*incomingTransfer),
		completed:  make(chan ReceivedFile, 8),
	}
	if dc != nil {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if err := handler.HandleDrop(msg); err != nil {
				log.Printf("[filedrop] error handling drop message: %v", err)
			}
		})
	}
	return handler
}

func (h *FileDropHandler) HandleDrop(msg webrtc.DataChannelMessage) error {
	if !msg.IsString {
		return errors.New("filedrop: expected text payload")
	}
	message, err := DecodeMessage(msg.Data)
	if err != nil {
		return err
	}

	switch message.Type {
	case MessageTypeDropStart:
		return h.handleStart(message)
	case MessageTypeDropChunk:
		return h.handleChunk(message)
	case MessageTypeDropComplete:
		return h.handleComplete(message)
	default:
		return fmt.Errorf("filedrop: unknown message type %q", message.Type)
	}
}

func (h *FileDropHandler) SendFile(path string) error {
	if h.dc == nil {
		return errors.New("filedrop: data channel not configured")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("filedrop: directories not supported")
	}

	transferID, err := randomID()
	if err != nil {
		return err
	}

	start := Message{
		Type:       MessageTypeDropStart,
		TransferID: transferID,
		Name:       filepath.Base(path),
		Size:       info.Size(),
	}
	if err := h.sendMessage(start); err != nil {
		return err
	}

	chunkSize := h.chunkSize
	if chunkSize <= 0 {
		chunkSize = defaultChunkSize
	}
	if chunkSize > maxChunkPayloadSize {
		chunkSize = maxChunkPayloadSize
	}

	buffer := make([]byte, chunkSize)
	var offset int64
	for {
		read, err := file.Read(buffer)
		if err != nil && err != io.EOF {
			return err
		}
		if read == 0 {
			break
		}
		chunk := Message{
			Type:       MessageTypeDropChunk,
			TransferID: transferID,
			Offset:     offset,
			Data:       EncodeChunk(buffer[:read]),
		}
		if err := h.sendMessage(chunk); err != nil {
			return err
		}
		offset += int64(read)
		if err == io.EOF {
			break
		}
	}

	complete := Message{
		Type:       MessageTypeDropComplete,
		TransferID: transferID,
	}
	return h.sendMessage(complete)
}

func (h *FileDropHandler) ReceiveFile() (ReceivedFile, error) {
	file, ok := <-h.completed
	if !ok {
		return ReceivedFile{}, errors.New("filedrop: handler closed")
	}
	return file, nil
}

func (h *FileDropHandler) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for _, transfer := range h.transfers {
		_ = transfer.file.Close()
		if transfer.path != "" {
			_ = os.Remove(transfer.path)
		}
	}
	h.transfers = make(map[string]*incomingTransfer)
	close(h.completed)
}

func (h *FileDropHandler) ensureReceiveDir() (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.receiveDir != "" {
		if err := os.MkdirAll(h.receiveDir, 0o700); err != nil {
			return "", err
		}
		return h.receiveDir, nil
	}

	receiveDir, err := os.MkdirTemp("", "breeze-filedrop-*")
	if err != nil {
		return "", err
	}
	h.receiveDir = receiveDir
	return receiveDir, nil
}

func (h *FileDropHandler) handleStart(message Message) error {
	if message.TransferID == "" {
		return errors.New("filedrop: missing transfer id")
	}
	if message.Name == "" {
		return errors.New("filedrop: missing file name")
	}

	// Sanitize filename to prevent path traversal
	safeName := filepath.Base(message.Name)
	if safeName == "." || safeName == ".." || safeName == string(filepath.Separator) {
		return fmt.Errorf("filedrop: invalid file name %q", message.Name)
	}
	// Reject hidden files and names with path separators
	if strings.ContainsAny(safeName, `/\`) || strings.HasPrefix(safeName, ".") {
		return fmt.Errorf("filedrop: invalid file name %q", message.Name)
	}

	// Enforce maximum transfer size
	if message.Size > maxTransferSize {
		return fmt.Errorf("filedrop: file size %d exceeds maximum %d", message.Size, maxTransferSize)
	}

	receiveDir, err := h.ensureReceiveDir()
	if err != nil {
		return err
	}
	filePath := filepath.Join(receiveDir, safeName)

	// Verify the resolved path is still within receiveDir
	absReceiveDir, err := filepath.Abs(receiveDir)
	if err != nil {
		return fmt.Errorf("filedrop: failed to resolve receive dir: %w", err)
	}
	absFilePath, err := filepath.Abs(filePath)
	if err != nil {
		return fmt.Errorf("filedrop: failed to resolve file path: %w", err)
	}
	if !strings.HasPrefix(absFilePath, absReceiveDir+string(filepath.Separator)) {
		return fmt.Errorf("filedrop: path traversal detected for %q", message.Name)
	}

	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		_ = file.Close()
		_ = os.Remove(filePath)
		return errors.New("filedrop: handler closed")
	}
	if _, exists := h.transfers[message.TransferID]; exists {
		_ = file.Close()
		_ = os.Remove(filePath)
		return errors.New("filedrop: duplicate transfer id")
	}
	if len(h.transfers) >= maxConcurrentTransfers {
		_ = file.Close()
		_ = os.Remove(filePath)
		return fmt.Errorf("filedrop: too many active transfers (max %d)", maxConcurrentTransfers)
	}
	h.transfers[message.TransferID] = &incomingTransfer{
		name: safeName,
		path: filePath,
		size: message.Size,
		file: file,
	}

	return nil
}

func (h *FileDropHandler) handleChunk(message Message) error {
	if message.TransferID == "" {
		return errors.New("filedrop: missing transfer id")
	}
	if len(message.Data) > maxBase64EncodedLen(maxChunkPayloadSize) {
		return fmt.Errorf("filedrop: chunk exceeds maximum %d bytes", maxChunkPayloadSize)
	}
	data, err := DecodeChunk(message.Data)
	if err != nil {
		return err
	}
	if len(data) > maxChunkPayloadSize {
		return fmt.Errorf("filedrop: chunk exceeds maximum %d bytes", maxChunkPayloadSize)
	}

	h.mu.Lock()
	transfer, ok := h.transfers[message.TransferID]
	if !ok {
		h.mu.Unlock()
		return errors.New("filedrop: unknown transfer")
	}
	// Validate offset and size to prevent sparse file attacks
	if message.Offset < 0 || message.Offset > transfer.size {
		h.mu.Unlock()
		return fmt.Errorf("filedrop: invalid offset %d for transfer size %d", message.Offset, transfer.size)
	}
	if transfer.received+int64(len(data)) > transfer.size {
		h.mu.Unlock()
		return fmt.Errorf("filedrop: received data exceeds declared file size %d", transfer.size)
	}
	if _, err := transfer.file.WriteAt(data, message.Offset); err != nil {
		h.mu.Unlock()
		return err
	}
	transfer.received += int64(len(data))
	h.mu.Unlock()
	return nil
}

func (h *FileDropHandler) handleComplete(message Message) error {
	if message.TransferID == "" {
		return errors.New("filedrop: missing transfer id")
	}

	h.mu.Lock()
	transfer, ok := h.transfers[message.TransferID]
	if ok {
		delete(h.transfers, message.TransferID)
	}
	h.mu.Unlock()
	if !ok {
		return errors.New("filedrop: unknown transfer")
	}

	if err := transfer.file.Close(); err != nil {
		return err
	}
	if transfer.received != transfer.size {
		_ = os.Remove(transfer.path)
		return fmt.Errorf("filedrop: incomplete transfer %s: received %d of %d bytes", message.TransferID, transfer.received, transfer.size)
	}

	result := ReceivedFile{
		TransferID: message.TransferID,
		Name:       transfer.name,
		Path:       transfer.path,
		Size:       transfer.size,
	}

	select {
	case h.completed <- result:
	default:
		log.Printf("[filedrop] completed channel full, dropping notification for %s", result.Name)
	}
	return nil
}

func (h *FileDropHandler) sendMessage(message Message) error {
	payload, err := EncodeMessage(message)
	if err != nil {
		return err
	}
	return h.dc.SendText(string(payload))
}

func randomID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", buf), nil
}

func maxBase64EncodedLen(decodedLen int) int {
	return ((decodedLen + 2) / 3) * 4
}
