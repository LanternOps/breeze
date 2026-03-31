package userhelper

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestSanitizeNotifyRequest(t *testing.T) {
	t.Parallel()

	req := sanitizeNotifyRequest(ipc.NotifyRequest{
		Title:   strings.Repeat("t", maxNotifyTitleBytes+20),
		Body:    strings.Repeat("b", maxNotifyBodyBytes+20),
		Icon:    strings.Repeat("i", maxNotifyIconBytes+20),
		Urgency: "URGENT",
		Actions: []string{" one ", strings.Repeat("a", maxNotifyTitleBytes+20), "three", "four", "five"},
	})

	if len(req.Title) != maxNotifyTitleBytes {
		t.Fatalf("title length = %d, want %d", len(req.Title), maxNotifyTitleBytes)
	}
	if len(req.Body) != maxNotifyBodyBytes {
		t.Fatalf("body length = %d, want %d", len(req.Body), maxNotifyBodyBytes)
	}
	if len(req.Icon) != maxNotifyIconBytes {
		t.Fatalf("icon length = %d, want %d", len(req.Icon), maxNotifyIconBytes)
	}
	if req.Urgency != "" {
		t.Fatalf("urgency = %q, want empty for unsupported value", req.Urgency)
	}
	if len(req.Actions) != 4 {
		t.Fatalf("actions length = %d, want 4", len(req.Actions))
	}
	if req.Actions[0] != "one" {
		t.Fatalf("first action = %q, want trimmed value", req.Actions[0])
	}
	if len(req.Actions[1]) != maxNotifyTitleBytes {
		t.Fatalf("second action length = %d, want %d", len(req.Actions[1]), maxNotifyTitleBytes)
	}
}
