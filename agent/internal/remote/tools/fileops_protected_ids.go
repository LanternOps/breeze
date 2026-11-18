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
// folders (bounded, links not followed), walking only keys/ of the agent's
// data folder.
func collectProtectedIdentities() protectedIdentitySet {
	files, dirs := protectedIdentitySources()
	dataDir, keysDir := protectedDataDirs()
	var skips []string
	if dataDir != "" {
		skips = append(skips, dataDir)
		dirs = append(dirs, keysDir)
	}
	return collectIdentities(files, dirs, skips)
}

// volumeProtectedSources lists, for the top folder of a mounted volume, the
// protected files and folders at that volume's root (its own system
// credential stores and agent folders), with the data folders to skip
// except for their keys/.
func volumeProtectedSources(top string) (files, dirs, skips []string) {
	join := func(rel string) string { return filepath.Join(top, filepath.FromSlash(rel)) }
	if runtime.GOOS == "windows" {
		for _, rel := range []string{"Windows/System32/config/SAM", "Windows/System32/config/SECURITY", "Windows/System32/config/SYSTEM", "Windows/NTDS/ntds.dit"} {
			files = append(files, join(rel))
		}
		dirs = []string{join("ProgramData/Breeze"), join("ProgramData/Breeze/data/keys")}
		skips = []string{join("ProgramData/Breeze/data")}
		return files, dirs, skips
	}
	for _, rel := range []string{"etc/shadow", "etc/gshadow", "etc/sudoers", "etc/master.passwd", "private/etc/master.passwd"} {
		files = append(files, join(rel))
	}
	dirs = []string{join("etc/sudoers.d"), join("etc/ssl/private"), join("etc/breeze"), join("Library/Keychains"),
		join("Library/Application Support/Breeze"), join("Library/Application Support/Breeze/data/keys"), join("var/lib/breeze/keys")}
	skips = []string{join("Library/Application Support/Breeze/data")}
	return files, dirs, skips
}

// collectIdentities records the identities of the existing regular files
// among files, then below dirs (bounded, links not followed, folders in
// skips left out).
func collectIdentities(files, dirs, skips []string) protectedIdentitySet {
	set := protectedIdentitySet{ids: map[fileIdentity]struct{}{}, complete: true}
	for _, f := range files {
		id, ok, err := identityOfPath(f)
		if err != nil && (runsPrivileged() || !errors.Is(err, fs.ErrPermission)) {
			set.complete = false
		}
		if ok {
			set.ids[id] = struct{}{}
		}
	}
	entries := 0
	for _, dir := range dirs {
		base := strings.Count(filepath.Clean(dir), string(filepath.Separator))
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
				for _, skip := range skips {
					if p != dir && filepath.Clean(p) == skip {
						return filepath.SkipDir // walked separately: only keys/
					}
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

// handleVolumeRoot returns the root of the volume the open file f is on,
// named by the volume's GUID (\\?\Volume{GUID}\), or "" where volumes are
// not named that way. volumeSourcesOf lists the protected files and folders
// at a volume's top. Variables so a test can stand in for a volume.
var (
	handleVolumeRoot = func(f *os.File) string {
		if vol, ok := handleVolumePath(f); ok {
			return volumeGUIDRoot(vol)
		}
		return ""
	}
	volumeSourcesOf = volumeProtectedSources
)

// volumeIdentitiesCache keeps, briefly, the protected-file identities at the
// root of each mounted volume the file operations have met.
var volumeIdentitiesCache struct {
	sync.Mutex
	sets map[string]protectedIdentitySet
	at   map[string]time.Time
}

// mountedVolumeTop returns top, the top folder of a mounted volume found
// from the mount table (or by device), or "" when top is "" or the
// filesystem root, whose protected files are in protectedIdentitiesCached.
// It applies only to such tops: a volume root named by its GUID is always its
// own parent folder, and gets its own set whichever volume it is.
func mountedVolumeTop(top string) string {
	if top == "" || filepath.Dir(top) == top {
		return ""
	}
	return top
}

// volumeIdentitiesOfHandle returns the protected-file identities at the root
// of the volume the open file f (final path final) is on: on Windows the
// volume named by its GUID (every volume, the system volume included),
// elsewhere the mount point holding it. The filesystem root and an unknown
// volume give an empty, complete set (the system's own files are in
// protectedIdentitiesCached).
func volumeIdentitiesOfHandle(f *os.File, final string) protectedIdentitySet {
	top := handleVolumeRoot(f)
	if top == "" {
		if table, ok := loadMountTable(); ok && final != "" {
			top = mountedVolumeTop(longestMountPoint(table, final))
		}
	}
	if top == "" {
		return protectedIdentitySet{complete: true}
	}
	volumeIdentitiesCache.Lock()
	defer volumeIdentitiesCache.Unlock()
	if volumeIdentitiesCache.sets == nil {
		volumeIdentitiesCache.sets, volumeIdentitiesCache.at = map[string]protectedIdentitySet{}, map[string]time.Time{}
	}
	if set, ok := volumeIdentitiesCache.sets[top]; ok && time.Since(volumeIdentitiesCache.at[top]) <= protectedIdentitiesTTL {
		return set
	}
	files, dirs, skips := volumeSourcesOf(top)
	set := collectIdentities(files, dirs, skips)
	volumeIdentitiesCache.sets[top], volumeIdentitiesCache.at[top] = set, time.Now()
	return set
}

// openFileLinks and openFileIdentity read an open file's link count and
// identity (variables so a test can make them fail).
var (
	openFileLinks    = linkCountOfOpenFile
	openFileIdentity = identityOfOpenFile
)

// isOtherNameOfProtectedFile reports whether the open file f must be treated
// as another name of a protected file: a regular file with more than one link
// whose identity is in one of the protected sets, or cannot be cleared
// because a set is incomplete. A link count or identity that cannot be read
// is treated as protected. info, when not nil, is f's stat information,
// which saves a query. Only a file with more than one link costs an identity
// read and the protected sets.
func isOtherNameOfProtectedFile(f *os.File, info fs.FileInfo, sets ...func() protectedIdentitySet) bool {
	links, err := openFileLinks(f, info)
	if err != nil {
		return true
	}
	if links <= 1 {
		return false
	}
	var (
		id     fileIdentity
		idRead bool
	)
	for _, protected := range sets {
		set := protected()
		if !set.complete {
			return true
		}
		if !idRead {
			if id, _, err = openFileIdentity(f); err != nil {
				return true
			}
			idRead = true
		}
		if _, hit := set.ids[id]; hit {
			return true
		}
	}
	return false
}
