package filedrop

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/pion/webrtc/v4"
)

const defaultChunkSize = 64 * 1024

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
}

type incomingTransfer struct {
	name     string
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
			_ = handler.HandleDrop(msg)
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
	for _, transfer := range h.transfers {
		_ = transfer.file.Close()
	}
	h.transfers = make(map[string]*incomingTransfer)
	close(h.completed)
	h.mu.Unlock()
}

func (h *FileDropHandler) handleStart(message Message) error {
	if message.TransferID == "" {
		return errors.New("filedrop: missing transfer id")
	}
	if message.Name == "" {
		return errors.New("filedrop: missing file name")
	}

	receiveDir := h.receiveDir
	if receiveDir == "" {
		receiveDir = os.TempDir()
	}
	if err := os.MkdirAll(receiveDir, 0o755); err != nil {
		return err
	}
	filePath := filepath.Join(receiveDir, message.Name)
	file, err := os.Create(filePath)
	if err != nil {
		return err
	}

	h.mu.Lock()
	h.transfers[message.TransferID] = &incomingTransfer{
		name: message.Name,
		size: message.Size,
		file: file,
	}
	h.mu.Unlock()

	return nil
}

func (h *FileDropHandler) handleChunk(message Message) error {
	if message.TransferID == "" {
		return errors.New("filedrop: missing transfer id")
	}
	data, err := DecodeChunk(message.Data)
	if err != nil {
		return err
	}

	h.mu.Lock()
	transfer, ok := h.transfers[message.TransferID]
	if !ok {
		h.mu.Unlock()
		return errors.New("filedrop: unknown transfer")
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

	receiveDir := h.receiveDir
	if receiveDir == "" {
		receiveDir = os.TempDir()
	}
	result := ReceivedFile{
		TransferID: message.TransferID,
		Name:       transfer.name,
		Path:       filepath.Join(receiveDir, transfer.name),
		Size:       transfer.size,
	}

	select {
	case h.completed <- result:
	default:
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
