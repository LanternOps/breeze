package config

import (
	"path/filepath"
	"testing"
)

func TestPathWithin(t *testing.T) {
	root := filepath.Join(string(filepath.Separator)+"tmp", "breeze-support-12")
	for _, tc := range []struct {
		name     string
		path     string
		foldCase bool
		want     bool
	}{
		{"root itself", root, false, true},
		{"file in root", filepath.Join(root, "agent.yaml"), false, true},
		{"nested", filepath.Join(root, "a", "b"), false, true},
		{"sibling sharing the prefix", root + "3", false, false},
		{"sibling file sharing the prefix", filepath.Join(root+"3", "agent.yaml"), false, false},
		{"parent", filepath.Dir(root), false, false},
		{"other case, case-sensitive", filepath.Join(filepath.Dir(root), "BREEZE-SUPPORT-12", "agent.yaml"), false, false},
		{"other case, folded", filepath.Join(filepath.Dir(root), "BREEZE-SUPPORT-12", "agent.yaml"), true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := pathWithin(root, tc.path, tc.foldCase); got != tc.want {
				t.Errorf("pathWithin(%q, %q, %v) = %v, want %v", root, tc.path, tc.foldCase, got, tc.want)
			}
		})
	}
}

// TestInUserWorkspaceOnlyAfterRegistration: nothing is a workspace path until
// SecureUserWorkspace succeeds, and only paths under the registered root are.
func TestInUserWorkspaceOnlyAfterRegistration(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-1")
	if inUserWorkspace(ws) {
		t.Fatal("unregistered path reported as workspace")
	}
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	if !inUserWorkspace(filepath.Join(ws, "agent.yaml")) {
		t.Error("file inside the registered workspace not recognised")
	}
	if inUserWorkspace(filepath.Join(filepath.Dir(ws), "agent.yaml")) {
		t.Error("file outside the registered workspace recognised")
	}
}
