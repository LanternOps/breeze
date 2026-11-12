package tools

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Protected file identities.
//
// A hard link gives a file a second name that no path rule can see. The
// fixed protected files (system credential stores and the agent's own
// configuration) are recorded by identity, so a file with more than one link
// can be compared against them wherever it is found.

const (
	maxProtectedIdentityEntries = 20000
	maxProtectedIdentityDepth   = 6
)

// protectedIdentitySources lists the fixed protected files and the folders
// whose files are protected, for this platform.
func protectedIdentitySources() (files, dirs []string) {
	if runtime.GOOS == "windows" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		files = []string{
			filepath.Join(root, "System32", "config", "SAM"),
			filepath.Join(root, "System32", "config", "SECURITY"),
			filepath.Join(root, "System32", "config", "SYSTEM"),
			filepath.Join(root, "NTDS", "ntds.dit"),
		}
		if pd := os.Getenv("ProgramData"); pd != "" {
			dirs = append(dirs, filepath.Join(pd, "Breeze"))
		}
	} else {
		files = []string{"/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/master.passwd", "/private/etc/master.passwd"}
		dirs = []string{"/etc/sudoers.d", "/etc/ssl/private", "/etc/breeze", "/Library/Keychains", "/Library/Application Support/Breeze"}
	}
	if cfg := agentConfigDirFunc(); cfg != "" {
		dirs = append(dirs, cfg)
	}
	return files, dirs
}

// collectProtectedIdentities records the identity of every existing fixed
// protected file, and of the regular files below the protected folders
// (bounded, links not followed).
func collectProtectedIdentities() map[fileIdentity]struct{} {
	out := map[fileIdentity]struct{}{}
	files, dirs := protectedIdentitySources()
	for _, f := range files {
		if id, ok := identityOfPath(f); ok {
			out[id] = struct{}{}
		}
	}
	entries := 0
	for _, dir := range dirs {
		base := strings.Count(filepath.Clean(dir), string(filepath.Separator))
		_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			entries++
			if entries > maxProtectedIdentityEntries {
				return filepath.SkipAll
			}
			if d.IsDir() {
				if strings.Count(p, string(filepath.Separator))-base >= maxProtectedIdentityDepth {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type().IsRegular() {
				if id, ok := identityOfPath(p); ok {
					out[id] = struct{}{}
				}
			}
			return nil
		})
	}
	return out
}

// protectedIdentitiesCache keeps the set briefly, for the file operations
// that consult it one file at a time (a directory copy, for example).
var protectedIdentitiesCache struct {
	sync.Mutex
	at        time.Time
	configDir string
	set       map[fileIdentity]struct{}
}

const protectedIdentitiesTTL = 10 * time.Second

func protectedIdentitiesCached() map[fileIdentity]struct{} {
	protectedIdentitiesCache.Lock()
	defer protectedIdentitiesCache.Unlock()
	cfg := agentConfigDirFunc()
	if protectedIdentitiesCache.set == nil || cfg != protectedIdentitiesCache.configDir ||
		time.Since(protectedIdentitiesCache.at) > protectedIdentitiesTTL {
		protectedIdentitiesCache.set = collectProtectedIdentities()
		protectedIdentitiesCache.at, protectedIdentitiesCache.configDir = time.Now(), cfg
	}
	return protectedIdentitiesCache.set
}

// isOtherNameOfProtectedFile reports whether the open file f is a regular
// file with more than one link whose identity is one of the protected files.
// The protected set is only computed when the link count calls for it.
func isOtherNameOfProtectedFile(f *os.File, protected func() map[fileIdentity]struct{}) bool {
	id, links, err := identityOfOpenFile(f)
	if err != nil || links <= 1 {
		return false
	}
	_, hit := protected()[id]
	return hit
}
