package workspaceindex

import (
	"context"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/time/rate"
)

// SourceFS provides the filesystem operations needed by Walk. Implementations
// must use Lstat semantics so symlink entries can be identified without being
// followed.
type SourceFS interface {
	ReadDir(path string) ([]fs.DirEntry, error)
	Stat(path string) (fs.FileInfo, error)
}

// WalkOptions configures exclusions, cursor resume, and filesystem throttling.
type WalkOptions struct {
	ExcludeGlobs []string
	ResumeCursor string
	Limiter      *rate.Limiter
}

var defaultExcludeGlobs = []string{
	"$RECYCLE.BIN/**",
	"System Volume Information/**",
	"**/AppData/**",
}

// Walk performs a deterministic lexicographic depth-first traversal of root.
// Directories are emitted before their children, and root itself is not
// emitted. The returned cursor is the last entry successfully emitted.
func Walk(
	ctx context.Context,
	fsys SourceFS,
	root string,
	opts WalkOptions,
	emit func(Entry) error,
) (lastCursor string, err error) {
	excludeGlobs := make([]string, 0, len(defaultExcludeGlobs)+len(opts.ExcludeGlobs))
	excludeGlobs = append(excludeGlobs, defaultExcludeGlobs...)
	excludeGlobs = append(excludeGlobs, opts.ExcludeGlobs...)

	var walkDir func(string, string) error
	walkDir = func(sourcePath, parentRelPath string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := waitForWalkOp(ctx, opts.Limiter); err != nil {
			return err
		}
		children, err := fsys.ReadDir(sourcePath)
		if err != nil {
			return err
		}
		sort.Slice(children, func(i, j int) bool {
			return children[i].Name() < children[j].Name()
		})

		for _, child := range children {
			if err := ctx.Err(); err != nil {
				return err
			}
			if child.Type()&fs.ModeSymlink != 0 {
				continue
			}

			relPath := child.Name()
			if parentRelPath != "" {
				relPath = path.Join(parentRelPath, child.Name())
			}
			isDir := child.IsDir()
			if excludedWalkPath(relPath, excludeGlobs) {
				continue
			}

			if compareWalkPaths(relPath, opts.ResumeCursor) > 0 {
				if err := waitForWalkOp(ctx, opts.Limiter); err != nil {
					return err
				}
				info, err := fsys.Stat(filepath.Join(root, filepath.FromSlash(relPath)))
				if err != nil {
					return err
				}
				if err := ctx.Err(); err != nil {
					return err
				}
				entry := walkEntry(relPath, info, isDir)
				if err := emit(entry); err != nil {
					return err
				}
				lastCursor = relPath
				if err := ctx.Err(); err != nil {
					return err
				}
			}

			if isDir && shouldDescendForCursor(relPath, opts.ResumeCursor) {
				if err := ctx.Err(); err != nil {
					return err
				}
				if err := walkDir(filepath.Join(root, filepath.FromSlash(relPath)), relPath); err != nil {
					return err
				}
			}
		}
		return nil
	}

	err = walkDir(filepath.Clean(root), "")
	return lastCursor, err
}

func waitForWalkOp(ctx context.Context, limiter *rate.Limiter) error {
	if limiter == nil {
		return ctx.Err()
	}
	return limiter.Wait(ctx)
}

func walkEntry(relPath string, info fs.FileInfo, isDir bool) Entry {
	parentPath := path.Dir(relPath)
	if parentPath == "." {
		parentPath = ""
	}
	entry := Entry{
		RelPath:    relPath,
		ParentPath: parentPath,
		Name:       path.Base(relPath),
		IsDir:      isDir,
		Mtime:      info.ModTime(),
		Attrs:      map[string]any{},
	}
	if isDir {
		return entry
	}

	entry.Size = info.Size()
	ext := path.Ext(entry.Name)
	if ext != "" && ext != entry.Name {
		ext = strings.ToLower(strings.TrimPrefix(ext, "."))
		entry.Ext = &ext
	}
	return entry
}

func shouldDescendForCursor(dirPath, cursor string) bool {
	return cursor == "" || compareWalkPaths(dirPath, cursor) >= 0 || strings.HasPrefix(cursor, dirPath+"/")
}

func compareWalkPaths(left, right string) int {
	leftSegments := strings.Split(left, "/")
	rightSegments := strings.Split(right, "/")
	shared := min(len(leftSegments), len(rightSegments))
	for i := 0; i < shared; i++ {
		if comparison := strings.Compare(leftSegments[i], rightSegments[i]); comparison != 0 {
			return comparison
		}
	}
	return len(leftSegments) - len(rightSegments)
}

// excludedWalkPath reports whether relPath is excluded from indexing. The
// dot-prefix rule applies to every path segment — files as well as
// directories. Indexing hidden files (.env, .npmrc, .pgpass directly inside a
// root) while skipping hidden directories was a privacy hole (#2425).
func excludedWalkPath(relPath string, globs []string) bool {
	for _, segment := range strings.Split(relPath, "/") {
		if strings.HasPrefix(segment, ".") {
			return true
		}
	}
	for _, pattern := range globs {
		if matchWalkGlob(pattern, relPath) {
			return true
		}
	}
	return false
}

func matchWalkGlob(pattern, relPath string) bool {
	pattern = strings.Trim(strings.ReplaceAll(pattern, "\\", "/"), "/")
	relPath = strings.Trim(relPath, "/")
	if pattern == "" || relPath == "" {
		return false
	}
	return matchWalkGlobSegments(strings.Split(pattern, "/"), strings.Split(relPath, "/"))
}

func matchWalkGlobSegments(pattern, value []string) bool {
	if len(pattern) == 0 {
		return len(value) == 0
	}
	if pattern[0] == "**" {
		if matchWalkGlobSegments(pattern[1:], value) {
			return true
		}
		return len(value) > 0 && matchWalkGlobSegments(pattern, value[1:])
	}
	if len(value) == 0 {
		return false
	}
	matched, err := path.Match(pattern[0], value[0])
	return err == nil && matched && matchWalkGlobSegments(pattern[1:], value[1:])
}
