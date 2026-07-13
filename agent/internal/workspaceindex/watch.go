package workspaceindex

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/fsnotify/fsnotify"
)

var errWatchDirCap = errors.New("workspace index watch directory cap exceeded")

type watchedRoot struct {
	dir    string
	prefix string
}

type pendingWatchEvent struct {
	name   string
	root   watchedRoot
	delete bool
}

// startWatch watches existing local-profile crawl directories. The returned
// stop function is idempotent and waits for the watcher goroutine to exit.
func startWatch(ctx context.Context, deps Deps, src SourceConfig) (stop func()) {
	deps = deps.withDefaults()
	if deps.Client == nil || src.Kind != "local_profile" || !src.Watch {
		return func() {}
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		deps.Log.Warn("create workspace index watcher", "sourceId", src.ID, "err", err)
		return func() {}
	}

	roots := make([]watchedRoot, 0)
	for _, target := range localProfileTargets(deps, src) {
		roots = append(roots, watchedRoot{dir: filepath.Clean(target.dir), prefix: target.prefix})
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].dir < roots[j].dir })
	watchGlobs := append([]string(nil), defaultExcludeGlobs...)
	watchGlobs = append(watchGlobs, src.ExcludeGlobs...)

	dirCount := 0
	watchedDirs := make(map[string]struct{})
	for _, root := range roots {
		if ctx.Err() != nil {
			_ = watcher.Close()
			return func() {}
		}
		err = addWatchTree(ctx, watcher, root, root.dir, watchGlobs, deps.WatchDirCap, &dirCount, watchedDirs)
		if err != nil {
			break
		}
	}
	if err != nil {
		_ = watcher.Close()
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return func() {}
		}
		if errors.Is(err, errWatchDirCap) {
			deps.Log.Warn("workspace index watch directory cap exceeded; using crawl only", "sourceId", src.ID, "cap", deps.WatchDirCap)
		} else {
			deps.Log.Warn("register workspace index watch directories; using crawl only", "sourceId", src.ID, "err", err)
		}
		return func() {}
	}
	if dirCount == 0 {
		_ = watcher.Close()
		return func() {}
	}

	watchCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer observability.Recoverer("workspaceindex.watch")
		defer watcher.Close()

		pending := make(map[string]pendingWatchEvent)
		var timer *time.Timer
		var timerC <-chan time.Time

		resetTimer := func() {
			if timer == nil {
				timer = time.NewTimer(deps.WatchDebounce)
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(deps.WatchDebounce)
			}
			timerC = timer.C
		}
		flush := func() {
			if len(pending) == 0 {
				return
			}
			paths := make([]string, 0, len(pending))
			for relPath := range pending {
				paths = append(paths, relPath)
			}
			sort.Slice(paths, func(i, j int) bool { return compareWalkPaths(paths[i], paths[j]) < 0 })
			upserts := make([]Entry, 0, len(paths))
			deletes := make([]string, 0, len(paths))
			for _, relPath := range paths {
				event := pending[relPath]
				if event.delete {
					deletes = append(deletes, relPath)
				} else {
					info, statErr := os.Lstat(event.name)
					if statErr != nil {
						if os.IsNotExist(statErr) {
							deletes = append(deletes, relPath)
						}
						continue
					}
					if info.Mode()&os.ModeSymlink != 0 {
						continue
					}
					entry := walkEntry(relPath, info, info.IsDir())
					if entry.ParentPath == "" {
						entry.ParentPath = event.root.prefix
					}
					upserts = append(upserts, entry)
				}
			}
			clear(pending)
			if postErr := deps.Client.PostEvents(watchCtx, src.ID, upserts, deletes); postErr != nil && watchCtx.Err() == nil {
				deps.Log.Warn("post workspace index watch events", "sourceId", src.ID, "err", postErr)
			}
		}
		handleEvent := func(event fsnotify.Event) bool {
			relPath, root, matched := watchRelPath(event.Name, roots)
			if !matched {
				return true
			}
			rootRelPath, relErr := filepath.Rel(root.dir, filepath.Clean(event.Name))
			if relErr != nil {
				return true
			}
			rootRelPath = filepath.ToSlash(rootRelPath)
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				if excludedWalkPath(rootRelPath, watchGlobs) {
					return true
				}
				pending[relPath] = pendingWatchEvent{delete: true}
				resetTimer()
				return true
			}
			if event.Op&(fsnotify.Create|fsnotify.Write) == 0 {
				return true
			}

			info, statErr := os.Lstat(event.Name)
			if statErr != nil {
				if os.IsNotExist(statErr) {
					if !excludedWalkPath(rootRelPath, watchGlobs) {
						pending[relPath] = pendingWatchEvent{delete: true}
						resetTimer()
					}
				}
				return true
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return true
			}
			if excludedWalkPath(rootRelPath, watchGlobs) {
				return true
			}
			if info.IsDir() && event.Op&fsnotify.Create != 0 {
				if addErr := addWatchTree(watchCtx, watcher, root, event.Name, watchGlobs, deps.WatchDirCap, &dirCount, watchedDirs); addErr != nil {
					deps.Log.Warn("workspace index watch directory cap or registration failure; using crawl only", "sourceId", src.ID, "cap", deps.WatchDirCap, "err", addErr)
					return false
				}
			}
			pending[relPath] = pendingWatchEvent{name: event.Name, root: root}
			resetTimer()
			return true
		}

		for {
			select {
			case <-watchCtx.Done():
				if timer != nil {
					timer.Stop()
				}
				return
			case watchErr, ok := <-watcher.Errors:
				if !ok {
					return
				}
				deps.Log.Warn("workspace index watcher failed; using crawl only", "sourceId", src.ID, "err", watchErr)
				return
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if !handleEvent(event) {
					return
				}
			case <-timerC:
				drained := false
			drainEvents:
				for {
					select {
					case event, ok := <-watcher.Events:
						if !ok {
							return
						}
						drained = true
						if !handleEvent(event) {
							return
						}
					default:
						break drainEvents
					}
				}
				if drained {
					continue
				}
				timerC = nil
				flush()
			}
		}
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}

func addWatchTree(
	ctx context.Context,
	watcher *fsnotify.Watcher,
	root watchedRoot,
	start string,
	globs []string,
	dirCap int,
	dirCount *int,
	watchedDirs map[string]struct{},
) error {
	return filepath.WalkDir(start, func(current string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root.dir, current)
		if err != nil {
			return err
		}
		if rel != "." && excludedWalkPath(filepath.ToSlash(rel), globs) {
			return filepath.SkipDir
		}
		current = filepath.Clean(current)
		if _, exists := watchedDirs[current]; exists {
			return nil
		}
		if *dirCount >= dirCap {
			return errWatchDirCap
		}
		if err := watcher.Add(current); err != nil {
			return err
		}
		watchedDirs[current] = struct{}{}
		*dirCount++
		return nil
	})
}

func watchRelPath(name string, roots []watchedRoot) (string, watchedRoot, bool) {
	cleanName := filepath.Clean(name)
	for _, root := range roots {
		rel, err := filepath.Rel(root.dir, cleanName)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if rel == "." {
			return root.prefix, root, true
		}
		return path.Join(root.prefix, filepath.ToSlash(rel)), root, true
	}
	return "", watchedRoot{}, false
}
