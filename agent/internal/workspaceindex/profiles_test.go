package workspaceindex

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestEnumerateProfileRootsAppliesPlatformExclusions(t *testing.T) {
	tests := []struct {
		name       string
		exclusions map[string]struct{}
	}{
		{name: "windows", exclusions: profileExclusionsForOS("windows")},
		{name: "darwin", exclusions: profileExclusionsForOS("darwin")},
		{name: "linux", exclusions: profileExclusionsForOS("linux")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base := t.TempDir()
			for excluded := range tt.exclusions {
				if err := os.Mkdir(filepath.Join(base, excluded), 0o755); err != nil {
					t.Fatalf("Mkdir excluded %q: %v", excluded, err)
				}
			}
			for _, username := range []string{"zoe", "alice"} {
				if err := os.Mkdir(filepath.Join(base, username), 0o755); err != nil {
					t.Fatalf("Mkdir profile %q: %v", username, err)
				}
			}
			if err := os.WriteFile(filepath.Join(base, "not-a-profile"), nil, 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}

			got := enumerateProfileRoots(base, tt.exclusions)
			want := []ProfileRoot{
				{Username: "alice", Dir: filepath.Join(base, "alice")},
				{Username: "zoe", Dir: filepath.Join(base, "zoe")},
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("roots = %#v, want %#v", got, want)
			}
		})
	}
}

func TestEnumerateProfileRootsUsesBaseOverride(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "local-user"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}

	got := EnumerateProfileRoots(base)
	want := []ProfileRoot{{Username: "local-user", Dir: filepath.Join(base, "local-user")}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("roots = %#v, want %#v", got, want)
	}
}

func TestEnumerateProfileRootsEmptyBase(t *testing.T) {
	if got := EnumerateProfileRoots(t.TempDir()); len(got) != 0 {
		t.Fatalf("roots = %#v, want empty", got)
	}
}

func TestProfileCrawlDirsIncludesOnlyPresentStandardDirectories(t *testing.T) {
	base := t.TempDir()
	profileDir := filepath.Join(base, "alice")
	if err := os.Mkdir(profileDir, 0o755); err != nil {
		t.Fatalf("Mkdir profile: %v", err)
	}
	for _, folder := range []string{"Documents", "Desktop"} {
		if err := os.Mkdir(filepath.Join(profileDir, folder), 0o755); err != nil {
			t.Fatalf("Mkdir %s: %v", folder, err)
		}
	}
	if err := os.WriteFile(filepath.Join(profileDir, "Pictures"), nil, 0o600); err != nil {
		t.Fatalf("WriteFile Pictures: %v", err)
	}

	got := ProfileCrawlDirs(ProfileRoot{Username: "alice", Dir: profileDir})
	want := []string{filepath.Join(profileDir, "Documents"), filepath.Join(profileDir, "Desktop")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("crawl dirs = %#v, want %#v", got, want)
	}
}
