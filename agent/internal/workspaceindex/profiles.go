package workspaceindex

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ProfileRoot identifies a local user's profile directory.
type ProfileRoot struct {
	Username string
	Dir      string
}

var standardProfileCrawlDirs = []string{"Documents", "Desktop", "Downloads", "Pictures"}

// EnumerateProfileRoots returns the user profile directories under
// baseOverride, or under the current platform's default profile base when the
// override is empty. Unreadable and missing bases produce an empty result.
func EnumerateProfileRoots(baseOverride string) []ProfileRoot {
	base := baseOverride
	if base == "" {
		base = defaultProfileBase
	}
	return enumerateProfileRoots(base, profileExclusionsForOS(runtime.GOOS))
}

func enumerateProfileRoots(base string, exclusions map[string]struct{}) []ProfileRoot {
	profiles := make([]ProfileRoot, 0)
	entries, err := os.ReadDir(base)
	if err != nil {
		return profiles
	}
	for _, entry := range entries {
		if !entry.IsDir() || excludedProfileName(entry.Name(), exclusions) {
			continue
		}
		profiles = append(profiles, ProfileRoot{
			Username: entry.Name(),
			Dir:      filepath.Join(base, entry.Name()),
		})
	}
	return profiles
}

func profileExclusionsForOS(goos string) map[string]struct{} {
	var names []string
	switch goos {
	case "windows":
		names = []string{"Public", "Default", "Default User", "All Users", "WDAGUtilityAccount", "desktop.ini"}
	case "darwin":
		names = []string{"Shared", ".localized", "Guest"}
	}

	exclusions := make(map[string]struct{}, len(names))
	for _, name := range names {
		exclusions[name] = struct{}{}
	}
	return exclusions
}

func excludedProfileName(name string, exclusions map[string]struct{}) bool {
	for excluded := range exclusions {
		if strings.EqualFold(name, excluded) {
			return true
		}
	}
	return false
}

// ProfileCrawlDirs returns the standard, existing directories to crawl for a
// profile. Local-profile entries use relPath <username>/<folder>/... so callers
// should prefix paths relative to each returned directory with root.Username
// and the directory's base name.
func ProfileCrawlDirs(root ProfileRoot) []string {
	dirs := make([]string, 0, len(standardProfileCrawlDirs))
	for _, name := range standardProfileCrawlDirs {
		dir := filepath.Join(root.Dir, name)
		info, err := os.Lstat(dir)
		if err == nil && info.IsDir() {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}
