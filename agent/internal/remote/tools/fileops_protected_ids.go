package tools

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
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

// maxProtectedIdentityEntries and maxProtectedIdentityDepth bound the walk of
// the protected folders. Reaching either leaves the set incomplete.
var (
	maxProtectedIdentityEntries = 20000
	maxProtectedIdentityDepth   = 6
)

// protectedIdentitySources lists the fixed protected files and the folders
// whose files are protected, for this platform. The agent's own
// configuration files are listed as files too, so they are recorded before
// any folder is walked.
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
		files = append(files, filepath.Join(cfg, "agent.yaml"), filepath.Join(cfg, "secrets.yaml"))
		dirs = append(dirs, cfg)
	}
	return files, uniqueOuterDirs(dirs)
}

// The agent's data folder holds state stores, logs, the quarantine and rule
// caches, which can grow large and are not credential material; only its
// keys/ folder is. The identity walk therefore skips the data folder and
// walks keys/ on its own. (The data folder stays a protected location for
// the path rules.)
func protectedDataDirs() (skip, keys string) {
	data := agentDataDirFunc()
	if data == "" && runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		data = "/var/lib/breeze"
	}
	if data == "" {
		return "", ""
	}
	return filepath.Clean(data), filepath.Join(filepath.Clean(data), "keys")
}

// uniqueOuterDirs drops duplicates and folders inside another listed folder,
// so each protected folder is walked once.
func uniqueOuterDirs(dirs []string) []string {
	fold := func(p string) string {
		p = filepath.Clean(p)
		if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
			p = strings.ToLower(p)
		}
		return p
	}
	cleaned := make([]string, 0, len(dirs))
	for _, d := range dirs {
		if d != "" {
			cleaned = append(cleaned, filepath.Clean(d))
		}
	}
	sort.Slice(cleaned, func(i, j int) bool { return len(cleaned[i]) < len(cleaned[j]) })
	var out []string
	for _, d := range cleaned {
		inside := false
		for _, o := range out {
			fo, fd := fold(o), fold(d)
			if fd == fo || strings.HasPrefix(fd, strings.TrimSuffix(fo, string(filepath.Separator))+string(filepath.Separator)) {
				inside = true
				break
			}
		}
		if !inside {
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return out
}

// protectedIdentitySet is the identities of the protected files. complete is
// false when some could not be recorded (a folder too large to walk, or a
// file or folder that could not be read while the agent runs privileged);
// a multi-linked file then cannot be cleared and is treated as protected.
type protectedIdentitySet struct {
	ids      map[fileIdentity]struct{}
	complete bool
}

// collectProtectedIdentities records the identity of every existing fixed
// protected file first, then of the regular files below the protected
// folders (bounded, links not followed).
func collectProtectedIdentities() protectedIdentitySet {
	set := protectedIdentitySet{ids: map[fileIdentity]struct{}{}, complete: true}
	files, dirs := protectedIdentitySources()
	for _, f := range files {
		id, ok, err := identityOfPath(f)
		if err != nil && (runsPrivileged() || !errors.Is(err, fs.ErrPermission)) {
			set.complete = false
		}
		if ok {
			set.ids[id] = struct{}{}
		}
	}
	dataDir, keysDir := protectedDataDirs()
	if keysDir != "" {
		dirs = append(dirs, keysDir)
	}
	entries := 0
	for _, dir := range dirs {
		base := strings.Count(filepath.Clean(dir), string(filepath.Separator))
		walkingKeys := dir == keysDir
		_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if !errors.Is(err, fs.ErrNotExist) && (runsPrivileged() || !errors.Is(err, fs.ErrPermission)) {
					set.complete = false
				}
				return nil
			}
			entries++
			if entries > maxProtectedIdentityEntries {
				set.complete = false
				return filepath.SkipAll
			}
			if d.IsDir() {
				if !walkingKeys && dataDir != "" && filepath.Clean(p) == dataDir {
					return filepath.SkipDir // walked separately: only keys/
				}
				if strings.Count(p, string(filepath.Separator))-base >= maxProtectedIdentityDepth {
					set.complete = false
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type().IsRegular() {
				id, ok, err := identityOfPath(p)
				if err != nil && (runsPrivileged() || !errors.Is(err, fs.ErrPermission)) {
					set.complete = false
				}
				if ok {
					set.ids[id] = struct{}{}
				}
			}
			return nil
		})
	}
	return set
}

// protectedIdentitiesCache keeps the set briefly, for the file operations
// that consult it one file at a time (a directory copy, for example).
var protectedIdentitiesCache struct {
	sync.Mutex
	at        time.Time
	configDir string
	set       protectedIdentitySet
	valid     bool
}

const protectedIdentitiesTTL = 10 * time.Second

func protectedIdentitiesCached() protectedIdentitySet {
	protectedIdentitiesCache.Lock()
	defer protectedIdentitiesCache.Unlock()
	cfg := agentConfigDirFunc()
	if !protectedIdentitiesCache.valid || cfg != protectedIdentitiesCache.configDir ||
		time.Since(protectedIdentitiesCache.at) > protectedIdentitiesTTL {
		protectedIdentitiesCache.set = collectProtectedIdentities()
		protectedIdentitiesCache.at, protectedIdentitiesCache.configDir, protectedIdentitiesCache.valid = time.Now(), cfg, true
	}
	return protectedIdentitiesCache.set
}

// openFileIdentity reads an open file's identity and link count (a variable
// so a test can make it fail).
var openFileIdentity = identityOfOpenFile

// isOtherNameOfProtectedFile reports whether the open file f must be treated
// as another name of a protected file: a regular file with more than one link
// whose identity is a protected one, or cannot be cleared because the
// protected set is incomplete. A file whose identity cannot be read is
// treated as protected. The protected set is only computed when the link
// count calls for it.
func isOtherNameOfProtectedFile(f *os.File, protected func() protectedIdentitySet) bool {
	id, links, err := openFileIdentity(f)
	if err != nil {
		return true
	}
	if links <= 1 {
		return false
	}
	set := protected()
	if !set.complete {
		return true
	}
	_, hit := set.ids[id]
	return hit
}
