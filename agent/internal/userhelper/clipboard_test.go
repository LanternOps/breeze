package userhelper

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
)

type stubClipboardProvider struct {
	getContent clipboard.Content
	getErr     error
	setContent clipboard.Content
	setErr     error
}

func (s *stubClipboardProvider) GetContent() (clipboard.Content, error) {
	return s.getContent, s.getErr
}

func (s *stubClipboardProvider) SetContent(content clipboard.Content) error {
	s.setContent = content
	return s.setErr
}

func createClientPipe(t *testing.T) (*Client, *ipc.Conn, func()) {
	t.Helper()

	serverConn, clientConn := net.Pipe()
	client := New("/tmp/test.sock", ipc.HelperRoleUser)
	client.conn = ipc.NewConn(serverConn)
	peer := ipc.NewConn(clientConn)

	cleanup := func() {
		_ = client.conn.Close()
		_ = peer.Close()
	}
	return client, peer, cleanup
}

func TestHandleClipboardGetResponds(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	provider := &stubClipboardProvider{
		getContent: clipboard.Content{
			Type: clipboard.ContentTypeText,
			Text: "hello clipboard",
		},
	}

	done := make(chan struct{})
	go func() {
		client.handleClipboardGetWithProvider(&ipc.Envelope{ID: "clip-get-1"}, provider)
		close(done)
	}()

	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	<-done

	if env.ID != "clip-get-1" {
		t.Fatalf("response id = %q, want clip-get-1", env.ID)
	}
	if env.Type != ipc.TypeClipboardData {
		t.Fatalf("response type = %q, want %q", env.Type, ipc.TypeClipboardData)
	}

	var payload struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Type != string(clipboard.ContentTypeText) || payload.Text != "hello clipboard" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestHandleClipboardSetRespondsAndWrites(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	provider := &stubClipboardProvider{}
	payload, err := json.Marshal(map[string]any{
		"type": "text",
		"text": "set me",
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	done := make(chan struct{})
	go func() {
		client.handleClipboardSetWithProvider(&ipc.Envelope{
			ID:      "clip-set-1",
			Payload: payload,
		}, provider)
		close(done)
	}()

	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	<-done

	if env.ID != "clip-set-1" {
		t.Fatalf("response id = %q, want clip-set-1", env.ID)
	}
	if env.Type != ipc.TypeClipboardSet {
		t.Fatalf("response type = %q, want %q", env.Type, ipc.TypeClipboardSet)
	}
	if provider.setContent.Type != clipboard.ContentTypeText || provider.setContent.Text != "set me" {
		t.Fatalf("unexpected clipboard write: %+v", provider.setContent)
	}
}

func TestHandleClipboardGetRejectsOversizedContent(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	provider := &stubClipboardProvider{
		getContent: clipboard.Content{
			Type: clipboard.ContentTypeText,
			Text: strings.Repeat("a", clipboard.MaxTextBytes+1),
		},
	}

	done := make(chan struct{})
	go func() {
		client.handleClipboardGetWithProvider(&ipc.Envelope{ID: "clip-get-oversized"}, provider)
		close(done)
	}()

	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	<-done

	if env.ID != "clip-get-oversized" {
		t.Fatalf("response id = %q, want clip-get-oversized", env.ID)
	}
	if env.Type != ipc.TypeClipboardData {
		t.Fatalf("response type = %q, want %q", env.Type, ipc.TypeClipboardData)
	}
	if env.Error == "" {
		t.Fatal("expected oversized clipboard_get to return an error")
	}
}

func TestHandleClipboardSetRejectsOversizedContent(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	provider := &stubClipboardProvider{}
	payload, err := json.Marshal(map[string]any{
		"type": "text",
		"text": strings.Repeat("a", clipboard.MaxTextBytes+1),
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	done := make(chan struct{})
	go func() {
		client.handleClipboardSetWithProvider(&ipc.Envelope{
			ID:      "clip-set-oversized",
			Payload: payload,
		}, provider)
		close(done)
	}()

	peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	<-done

	if env.ID != "clip-set-oversized" {
		t.Fatalf("response id = %q, want clip-set-oversized", env.ID)
	}
	if env.Type != ipc.TypeClipboardSet {
		t.Fatalf("response type = %q, want %q", env.Type, ipc.TypeClipboardSet)
	}
	if env.Error == "" {
		t.Fatal("expected oversized clipboard_set to return an error")
	}
	if provider.setContent.Text != "" {
		t.Fatalf("expected provider not to be written, got %+v", provider.setContent)
	}
}
