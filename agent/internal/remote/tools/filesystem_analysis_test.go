package tools

import (
	"fmt"
	"testing"
)

func TestReadCheckpointFramesCapsEntries(t *testing.T) {
	pending := make([]any, 0, maxFSCheckpointDirs+10)
	for i := 0; i < maxFSCheckpointDirs+10; i++ {
		pending = append(pending, map[string]any{
			"path":  "/tmp/test",
			"depth": 1,
		})
	}

	frames := readCheckpointFrames(map[string]any{
		"pendingDirs": pending,
	})

	if len(frames) != maxFSCheckpointDirs {
		t.Fatalf("expected %d frames, got %d", maxFSCheckpointDirs, len(frames))
	}
}

func TestReadTargetDirectoriesCapsEntries(t *testing.T) {
	raw := make([]any, 0, maxFSTargetDirectories+10)
	for i := 0; i < maxFSTargetDirectories+10; i++ {
		raw = append(raw, fmt.Sprintf("/tmp/test-%d", i))
	}

	dirs := readTargetDirectories(raw)
	if len(dirs) > maxFSTargetDirectories {
		t.Fatalf("expected at most %d target dirs, got %d", maxFSTargetDirectories, len(dirs))
	}
}

func TestBuildCheckpointPayloadMarksTruncation(t *testing.T) {
	frames := make([]scanDirFrame, 0, 3)
	for i := 0; i < 3; i++ {
		frames = append(frames, scanDirFrame{path: "/tmp/test", depth: i})
	}

	payload := buildCheckpointPayload(frames, 2)
	pending, ok := payload["pendingDirs"].([]map[string]any)
	if !ok {
		t.Fatalf("expected pendingDirs payload, got %#v", payload["pendingDirs"])
	}
	if len(pending) != 2 {
		t.Fatalf("expected 2 checkpoint entries, got %d", len(pending))
	}
	if truncated, _ := payload["truncated"].(bool); !truncated {
		t.Fatal("expected truncated flag to be set")
	}
}
