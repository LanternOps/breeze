package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultFSBaselineMaxDepth    = 32
	defaultFSIncrementalMaxDepth = 12
	maxFSMaxDepth                = 64
	defaultFSTopFiles            = 50
	defaultFSTopDirs             = 30
	defaultFSMaxEntries          = 10_000_000
	maxFSMaxEntries              = 25_000_000
	defaultFSTimeoutSecs         = 20
	maxFSErrors                  = 200
	maxFSCleanupCandidates       = 1000
	maxFSCheckpointDirs          = 5000
	maxFSTargetDirectories       = 1000
	unrotatedLogMinBytes         = 100 * 1024 * 1024
	defaultFSWorkerCap           = 8
	maxFSWorkers                 = 32
)

// virtualFSPaths contains top-level paths for virtual/pseudo filesystems
// that should be skipped during scanning. These paths do not represent real
// disk usage (e.g. /proc/kcore reports ~140 TB which is the kernel address space).
var virtualFSPaths = map[string]struct{}{
	"/proc": {},
	"/sys":  {},
	"/dev":  {},
	"/run":  {},
}

// isVirtualFilesystem returns true if the path is or lives under a virtual
// filesystem mount point that should be excluded from disk usage scanning.
func isVirtualFilesystem(path string) bool {
	if runtime.GOOS == "windows" {
		return false
	}
	cleaned := filepath.Clean(path)
	for vfs := range virtualFSPaths {
		if cleaned == vfs || strings.HasPrefix(cleaned, vfs+"/") {
			return true
		}
	}
	return false
}

type scanDirFrame struct {
	path  string
	depth int
}

type fsDirAggregate struct {
	Path       string
	Parent     string
	Depth      int
	SizeBytes  int64
	FileCount  int64
	Incomplete bool
}

type duplicateGroup struct {
	Key       string
	SizeBytes int64
	Paths     []string
}

// AnalyzeFilesystem runs deep filesystem analysis for BE-1.
func AnalyzeFilesystem(payload map[string]any) CommandResult {
	start := time.Now()

	rootPath, errResult := RequirePayloadString(payload, "path")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	scanMode := parseFilesystemScanMode(GetPayloadString(payload, "scanMode", "baseline"))
	defaultMaxDepth := defaultFSBaselineMaxDepth
	if scanMode == "incremental" {
		defaultMaxDepth = defaultFSIncrementalMaxDepth
	}

	maxDepth := clampInt(GetPayloadInt(payload, "maxDepth", defaultMaxDepth), 1, maxFSMaxDepth)
	topFilesLimit := clampInt(GetPayloadInt(payload, "topFiles", defaultFSTopFiles), 1, 500)
	topDirsLimit := clampInt(GetPayloadInt(payload, "topDirs", defaultFSTopDirs), 1, 200)
	maxEntries := clampInt(GetPayloadInt(payload, "maxEntries", defaultFSMaxEntries), 1000, maxFSMaxEntries)
	timeoutSecs := clampInt(GetPayloadInt(payload, "timeoutSeconds", defaultFSTimeoutSecs), 5, 900)
	followSymlinks := GetPayloadBool(payload, "followSymlinks", false)

	defaultWorkers := clampInt(runtime.NumCPU(), 2, defaultFSWorkerCap)
	if scanMode == "incremental" {
		defaultWorkers = clampInt(defaultWorkers, 1, 4)
	}
	workerCount := clampInt(GetPayloadInt(payload, "workers", defaultWorkers), 1, maxFSWorkers)

	cleanRoot := filepath.Clean(rootPath)
	rootInfo, err := os.Stat(cleanRoot)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to stat path: %w", err), time.Since(start).Milliseconds())
	}
	if !rootInfo.IsDir() {
		return NewErrorResult(fmt.Errorf("path is not a directory: %s", cleanRoot), time.Since(start).Milliseconds())
	}

	now := time.Now()
	deadline := now.Add(time.Duration(timeoutSecs) * time.Second)
	oldDownloadsThreshold := now.Add(-30 * 24 * time.Hour)

	dirStats := map[string]*fsDirAggregate{}
	dirStack := []scanDirFrame{}
	visitedDirs := map[string]struct{}{}

	checkpointFrames := readCheckpointFrames(payload["checkpoint"])
	if len(checkpointFrames) > 0 {
		dirStack = append(dirStack, checkpointFrames...)
		for _, frame := range checkpointFrames {
			visitedDirs[frame.path] = struct{}{}
			if _, ok := dirStats[frame.path]; !ok {
				dirStats[frame.path] = &fsDirAggregate{
					Path:   frame.path,
					Parent: "",
					Depth:  frame.depth,
				}
			}
		}
	} else {
		targets := readTargetDirectories(payload["targetDirectories"])
		if scanMode == "incremental" && len(targets) > 0 {
			for _, target := range targets {
				if _, statErr := os.Stat(target); statErr != nil {
					continue
				}
				dirStack = append(dirStack, scanDirFrame{path: target, depth: 0})
				visitedDirs[target] = struct{}{}
				dirStats[target] = &fsDirAggregate{
					Path:   target,
					Parent: "",
					Depth:  0,
				}
			}
		}
		if len(dirStack) == 0 {
			dirStack = []scanDirFrame{{path: cleanRoot, depth: 0}}
			visitedDirs[cleanRoot] = struct{}{}
			dirStats[cleanRoot] = &fsDirAggregate{
				Path:   cleanRoot,
				Parent: "",
				Depth:  0,
			}
		}
	}

	tempBytes := make(map[string]int64)
	duplicateByKey := make(map[string]*duplicateGroup)
	cleanupByPath := make(map[string]FilesystemCleanupCandidate)

	topLargestFiles := make([]FilesystemLargestFile, 0, topFilesLimit)
	topLargestDirs := make([]FilesystemLargestDirectory, 0, topDirsLimit)
	oldDownloads := make([]FilesystemOldDownload, 0, 128)
	unrotatedLogs := make([]FilesystemUnrotatedLog, 0, 128)
	trashUsage := make([]FilesystemTrashUsage, 0, 4)
	scanErrors := make([]FilesystemScanError, 0, 32)

	var filesScanned int64
	var dirsScanned int64
	var bytesScanned int64
	var permissionDeniedCount int64
	var maxDepthReached int
	entriesSeen := int64(0)
	partial := false
	reason := ""
	stopping := false
	done := len(dirStack) == 0
	activeWorkers := 0
	var queueMu sync.Mutex
	queueCond := sync.NewCond(&queueMu)
	var statsMu sync.Mutex

	notePartial := func(partialReason string) {
		queueMu.Lock()
		partial = true
		if reason == "" && partialReason != "" {
			reason = partialReason
		}
		queueMu.Unlock()
	}

	requestStop := func(stopReason string) {
		queueMu.Lock()
		partial = true
		stopping = true
		if stopReason != "" && (reason == "" || reason == "max depth reached") {
			reason = stopReason
		}
		queueCond.Broadcast()
		queueMu.Unlock()
	}

	processDir := func(frame scanDirFrame) {
		if time.Now().After(deadline) {
			requestStop("timeout reached")
			queueMu.Lock()
			dirStack = append(dirStack, frame)
			queueCond.Broadcast()
			queueMu.Unlock()
			return
		}

		// Read entries in directory order rather than os.ReadDir's filename-sorted
		// order — this scanner aggregates over every entry and never relies on
		// order, so the per-directory sort is pure overhead across a large tree.
		dirFile, openErr := os.Open(frame.path)
		if openErr != nil {
			statsMu.Lock()
			markDirAndAncestorsIncomplete(dirStats, frame.path)
			appendScanError(&scanErrors, frame.path, openErr, &permissionDeniedCount)
			statsMu.Unlock()
			return
		}
		entries, readErr := dirFile.ReadDir(-1)
		// Entries are already read into memory; the dir handle's Close error is
		// not actionable (and `_ =` satisfies errcheck).
		_ = dirFile.Close()
		if readErr != nil {
			statsMu.Lock()
			markDirAndAncestorsIncomplete(dirStats, frame.path)
			appendScanError(&scanErrors, frame.path, readErr, &permissionDeniedCount)
			statsMu.Unlock()
			return
		}

		statsMu.Lock()
		dirsScanned++
		if frame.depth > maxDepthReached {
			maxDepthReached = frame.depth
		}
		statsMu.Unlock()

		maxEntriesExceeded := false
		for _, entry := range entries {
			currentEntries := atomic.AddInt64(&entriesSeen, 1)
			entryPath := filepath.Join(frame.path, entry.Name())

			info, infoErr := entry.Info()
			if infoErr != nil {
				statsMu.Lock()
				appendScanError(&scanErrors, entryPath, infoErr, &permissionDeniedCount)
				statsMu.Unlock()
				continue
			}

			mode := info.Mode()
			if mode&os.ModeSymlink != 0 && !followSymlinks {
				continue
			}

			isDir := info.IsDir()
			if mode&os.ModeSymlink != 0 && followSymlinks {
				targetInfo, statErr := os.Stat(entryPath)
				if statErr != nil {
					statsMu.Lock()
					appendScanError(&scanErrors, entryPath, statErr, &permissionDeniedCount)
					statsMu.Unlock()
					continue
				}
				info = targetInfo
				isDir = targetInfo.IsDir()
			}

			if isDir {
				if isVirtualFilesystem(entryPath) {
					continue
				}
				childDepth := frame.depth + 1
				normalizedPath := entryPath
				shouldQueue := false

				statsMu.Lock()
				if _, ok := dirStats[normalizedPath]; !ok {
					dirStats[normalizedPath] = &fsDirAggregate{
						Path:   normalizedPath,
						Parent: frame.path,
						Depth:  childDepth,
					}
				}
				if childDepth <= maxDepth {
					if _, seen := visitedDirs[normalizedPath]; !seen {
						visitedDirs[normalizedPath] = struct{}{}
						shouldQueue = true
					}
				} else {
					markDirAndAncestorsIncomplete(dirStats, normalizedPath)
				}
				statsMu.Unlock()

				if childDepth > maxDepth {
					notePartial("max depth reached")
				}

				if shouldQueue {
					queueMu.Lock()
					dirStack = append(dirStack, scanDirFrame{path: normalizedPath, depth: childDepth})
					queueCond.Signal()
					queueMu.Unlock()
				}
				continue
			}

			// Skip files in virtual filesystems (e.g. /proc/kcore reports ~140 TB).
			if isVirtualFilesystem(entryPath) {
				continue
			}

			fileSize := info.Size()
			if fileSize < 0 {
				fileSize = 0
			}

			// Global counters are contention-free — keep them off the shared lock.
			atomic.AddInt64(&filesScanned, 1)
			atomic.AddInt64(&bytesScanned, fileSize)

			// Classification is pure (touches no shared state), so run it before
			// taking the lock instead of holding every other worker off while we do.
			category := classifyCleanupCategory(entryPath)
			oldDownload := isOldDownload(entryPath, fileSize, info.ModTime(), oldDownloadsThreshold)
			unrotated := isUnrotatedLog(entryPath, fileSize)

			// modifiedAt is needed by several retention buckets; format it at most
			// once, and only when a bucket actually keeps this file.
			modifiedAt := ""
			modTimeResolved := false
			resolveModTime := func() string {
				if !modTimeResolved {
					modifiedAt = info.ModTime().UTC().Format(time.RFC3339)
					modTimeResolved = true
				}
				return modifiedAt
			}

			// Owner for old downloads is known now; resolve it outside the lock.
			// The top-N owner is resolved lazily under the lock (cached, so a map
			// hit) only when the file actually qualifies — see fileQualifiesForTop.
			var oldDownloadOwner string
			if oldDownload {
				oldDownloadOwner = getFileOwner(info)
			}

			statsMu.Lock()
			if parentAgg, ok := dirStats[frame.path]; ok {
				parentAgg.SizeBytes += fileSize
				parentAgg.FileCount++
			}

			if fileQualifiesForTop(topLargestFiles, fileSize, topFilesLimit) {
				addTopLargestFile(&topLargestFiles, FilesystemLargestFile{
					Path:       entryPath,
					SizeBytes:  fileSize,
					ModifiedAt: resolveModTime(),
					Owner:      getFileOwner(info),
				}, topFilesLimit)
			}

			if category != "" {
				tempBytes[category] += fileSize
				addCleanupCandidate(cleanupByPath, FilesystemCleanupCandidate{
					Path:       entryPath,
					Category:   category,
					SizeBytes:  fileSize,
					Safe:       true,
					Reason:     "temporary/cache file",
					ModifiedAt: resolveModTime(),
				}, maxFSCleanupCandidates)
			}

			if oldDownload {
				oldDownloads = append(oldDownloads, FilesystemOldDownload{
					Path:       entryPath,
					SizeBytes:  fileSize,
					ModifiedAt: resolveModTime(),
					Owner:      oldDownloadOwner,
				})
			}

			if unrotated {
				unrotatedLogs = append(unrotatedLogs, FilesystemUnrotatedLog{
					Path:       entryPath,
					SizeBytes:  fileSize,
					ModifiedAt: resolveModTime(),
				})
			}

			addDuplicateCandidate(duplicateByKey, entryPath, fileSize)
			statsMu.Unlock()

			if currentEntries > int64(maxEntries) {
				requestStop("max entries reached")
				statsMu.Lock()
				markDirAndAncestorsIncomplete(dirStats, frame.path)
				statsMu.Unlock()
				maxEntriesExceeded = true
				break
			}
		}

		if maxEntriesExceeded {
			return
		}

		if time.Now().After(deadline) {
			requestStop("timeout reached")
		}
	}

	var workers sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				queueMu.Lock()
				for len(dirStack) == 0 && !done && !stopping {
					queueCond.Wait()
				}
				if stopping || done {
					queueMu.Unlock()
					return
				}

				idx := len(dirStack) - 1
				frame := dirStack[idx]
				dirStack = dirStack[:idx]
				activeWorkers++
				queueMu.Unlock()

				processDir(frame)

				queueMu.Lock()
				activeWorkers--
				if !stopping && len(dirStack) == 0 && activeWorkers == 0 {
					done = true
				}
				queueCond.Broadcast()
				queueMu.Unlock()
			}
		}()
	}

	queueMu.Lock()
	for !done && !(stopping && activeWorkers == 0) {
		queueCond.Wait()
	}
	pendingFrames := append([]scanDirFrame(nil), dirStack...)
	queueMu.Unlock()
	workers.Wait()

	if len(pendingFrames) > 0 {
		statsMu.Lock()
		for _, pending := range pendingFrames {
			markDirAndAncestorsIncomplete(dirStats, pending.path)
		}
		statsMu.Unlock()
	}

	// Aggregate child directory sizes into parents. Iterating deepest-first
	// guarantees a directory's own size is final by the time it is visited (all
	// strictly-deeper descendants have already folded in), so we can collect the
	// top-N candidate in the same pass instead of a second full map traversal.
	orderedDirs := make([]*fsDirAggregate, 0, len(dirStats))
	for _, agg := range dirStats {
		orderedDirs = append(orderedDirs, agg)
	}
	sort.Slice(orderedDirs, func(i, j int) bool {
		return orderedDirs[i].Depth > orderedDirs[j].Depth
	})

	topDirCandidateLimit := clampInt(topDirsLimit*8, topDirsLimit, 2000)
	topLargestDirCandidates := make([]FilesystemLargestDirectory, 0, topDirCandidateLimit)
	for _, agg := range orderedDirs {
		addTopLargestDir(&topLargestDirCandidates, FilesystemLargestDirectory{
			Path:      agg.Path,
			SizeBytes: agg.SizeBytes,
			FileCount: agg.FileCount,
			Estimated: agg.Incomplete,
		}, topDirCandidateLimit)

		if agg.Parent == "" {
			continue
		}
		parent, ok := dirStats[agg.Parent]
		if !ok {
			continue
		}
		parent.SizeBytes += agg.SizeBytes
		parent.FileCount += agg.FileCount
		if agg.Incomplete {
			parent.Incomplete = true
		}
	}
	topLargestDirs = collapseAncestorDirectories(topLargestDirCandidates, topDirsLimit, 0.70)
	sort.Slice(oldDownloads, func(i, j int) bool { return oldDownloads[i].SizeBytes > oldDownloads[j].SizeBytes })
	if len(oldDownloads) > 200 {
		oldDownloads = oldDownloads[:200]
	}
	sort.Slice(unrotatedLogs, func(i, j int) bool { return unrotatedLogs[i].SizeBytes > unrotatedLogs[j].SizeBytes })
	if len(unrotatedLogs) > 200 {
		unrotatedLogs = unrotatedLogs[:200]
	}

	// Trash usage is calculated separately from known locations.
	for _, trashPath := range getTrashPaths() {
		size, _, timedOut, trashErr := estimateDirectorySize(trashPath, deadline, maxEntries/2)
		if trashErr != nil {
			if !os.IsNotExist(trashErr) {
				appendScanError(&scanErrors, trashPath, trashErr, &permissionDeniedCount)
			}
			continue
		}
		if timedOut {
			partial = true
			if reason == "" {
				reason = "timeout reached while scanning trash"
			}
		}
		if size <= 0 {
			continue
		}
		trashUsage = append(trashUsage, FilesystemTrashUsage{
			Path:      trashPath,
			SizeBytes: size,
		})
		addCleanupCandidate(cleanupByPath, FilesystemCleanupCandidate{
			Path:      trashPath,
			Category:  "trash",
			SizeBytes: size,
			Safe:      true,
			Reason:    "trash/recycle bin cleanup",
		}, maxFSCleanupCandidates)
	}

	tempAccumulation := make([]FilesystemAccumulation, 0, len(tempBytes))
	for category, bytes := range tempBytes {
		tempAccumulation = append(tempAccumulation, FilesystemAccumulation{
			Category: category,
			Bytes:    bytes,
		})
	}
	sort.Slice(tempAccumulation, func(i, j int) bool { return tempAccumulation[i].Bytes > tempAccumulation[j].Bytes })
	sort.Slice(trashUsage, func(i, j int) bool { return trashUsage[i].SizeBytes > trashUsage[j].SizeBytes })

	duplicateCandidates := buildDuplicateCandidateList(duplicateByKey, 200)
	cleanupCandidates := mapCleanupCandidates(cleanupByPath, maxFSCleanupCandidates)

	completedAt := time.Now()
	pendingCheckpoint := buildCheckpointPayload(pendingFrames, maxFSCheckpointDirs)
	response := FilesystemAnalysisResponse{
		Path:        cleanRoot,
		ScanMode:    scanMode,
		StartedAt:   start.UTC().Format(time.RFC3339),
		CompletedAt: completedAt.UTC().Format(time.RFC3339),
		DurationMs:  completedAt.Sub(start).Milliseconds(),
		Partial:     partial,
		Reason:      reason,
		Checkpoint:  pendingCheckpoint,
		Summary: FilesystemAnalysisSummary{
			FilesScanned:          filesScanned,
			DirsScanned:           dirsScanned,
			BytesScanned:          bytesScanned,
			MaxDepthReached:       maxDepthReached,
			PermissionDeniedCount: permissionDeniedCount,
		},
		TopLargestFiles:     topLargestFiles,
		TopLargestDirs:      topLargestDirs,
		TempAccumulation:    tempAccumulation,
		OldDownloads:        oldDownloads,
		UnrotatedLogs:       unrotatedLogs,
		TrashUsage:          trashUsage,
		DuplicateCandidates: duplicateCandidates,
		CleanupCandidates:   cleanupCandidates,
		Errors:              scanErrors,
	}

	return NewSuccessResult(response, response.DurationMs)
}

func parseFilesystemScanMode(value string) string {
	mode := strings.TrimSpace(strings.ToLower(value))
	if mode == "incremental" {
		return "incremental"
	}
	return "baseline"
}

func readCheckpointFrames(raw any) []scanDirFrame {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	pending, ok := obj["pendingDirs"].([]any)
	if !ok {
		return nil
	}
	frames := make([]scanDirFrame, 0, len(pending))
	for _, item := range pending {
		if len(frames) >= maxFSCheckpointDirs {
			break
		}
		entry, entryOk := item.(map[string]any)
		if !entryOk {
			continue
		}
		pathRaw, hasPath := entry["path"].(string)
		if !hasPath || pathRaw == "" {
			continue
		}
		path := filepath.Clean(pathRaw)
		depth := clampInt(GetPayloadInt(entry, "depth", 0), 0, maxFSMaxDepth)
		frames = append(frames, scanDirFrame{path: path, depth: depth})
	}
	return frames
}

func readTargetDirectories(raw any) []string {
	entries, ok := raw.([]any)
	if !ok || len(entries) == 0 {
		return nil
	}
	dirs := make([]string, 0, len(entries))
	seen := make(map[string]struct{})
	for _, item := range entries {
		if len(dirs) >= maxFSTargetDirectories {
			break
		}
		pathRaw, ok := item.(string)
		if !ok || pathRaw == "" {
			continue
		}
		path := filepath.Clean(pathRaw)
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		dirs = append(dirs, path)
	}
	return dirs
}

func buildCheckpointPayload(frames []scanDirFrame, limit int) map[string]any {
	if len(frames) == 0 {
		return map[string]any{}
	}
	if limit <= 0 {
		limit = len(frames)
	}
	items := make([]map[string]any, 0, minInt(len(frames), limit))
	for idx, frame := range frames {
		if idx >= limit {
			break
		}
		items = append(items, map[string]any{
			"path":  frame.path,
			"depth": frame.depth,
		})
	}
	result := map[string]any{
		"pendingDirs": items,
	}
	if len(frames) > limit {
		result["truncated"] = true
		result["remainingCount"] = len(frames)
	}
	return result
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// fileQualifiesForTop reports whether a file of the given size would be kept in
// the top-N slice, so callers can skip the cost of resolving its owner/modtime
// when it wouldn't. Must be called under the same lock that guards `top`.
func fileQualifiesForTop(top []FilesystemLargestFile, size int64, limit int) bool {
	if limit <= 0 {
		return false
	}
	if len(top) < limit {
		return true
	}
	return size > top[len(top)-1].SizeBytes
}

// addTopLargestFile keeps `top` sorted by SizeBytes descending, bounded to
// `limit`. It inserts at the correct position (binary search + single shift)
// rather than re-sorting the whole slice on every insert, so the per-file cost
// is O(limit) worst case instead of O(limit·log limit).
func addTopLargestFile(top *[]FilesystemLargestFile, file FilesystemLargestFile, limit int) {
	if limit <= 0 {
		return
	}
	s := *top
	n := len(s)
	if n >= limit {
		if file.SizeBytes <= s[n-1].SizeBytes {
			return
		}
		// Insert into descending order, dropping the current minimum (last).
		idx := sort.Search(n, func(i int) bool { return s[i].SizeBytes < file.SizeBytes })
		copy(s[idx+1:], s[idx:n-1])
		s[idx] = file
		return
	}
	idx := sort.Search(n, func(i int) bool { return s[i].SizeBytes < file.SizeBytes })
	s = append(s, file)
	copy(s[idx+1:], s[idx:n])
	s[idx] = file
	*top = s
}

// addTopLargestDir mirrors addTopLargestFile for directory aggregates.
func addTopLargestDir(top *[]FilesystemLargestDirectory, dir FilesystemLargestDirectory, limit int) {
	if limit <= 0 {
		return
	}
	s := *top
	n := len(s)
	if n >= limit {
		if dir.SizeBytes <= s[n-1].SizeBytes {
			return
		}
		idx := sort.Search(n, func(i int) bool { return s[i].SizeBytes < dir.SizeBytes })
		copy(s[idx+1:], s[idx:n-1])
		s[idx] = dir
		return
	}
	idx := sort.Search(n, func(i int) bool { return s[i].SizeBytes < dir.SizeBytes })
	s = append(s, dir)
	copy(s[idx+1:], s[idx:n])
	s[idx] = dir
	*top = s
}

func collapseAncestorDirectories(
	candidates []FilesystemLargestDirectory,
	limit int,
	descendantRatio float64,
) []FilesystemLargestDirectory {
	if limit <= 0 || len(candidates) == 0 {
		return []FilesystemLargestDirectory{}
	}
	if descendantRatio <= 0 {
		descendantRatio = 0.70
	}

	// Precompute the normalized path + depth once per candidate. The O(n²)
	// pairwise descendant check below would otherwise re-normalize both paths on
	// every comparison (up to ~4M comparisons × 2 normalizations, each allocating
	// several strings) for a single scan's post-processing.
	items := make([]collapseCandidate, len(candidates))
	for i, c := range candidates {
		norm := normalizePathForHierarchy(c.Path)
		items[i] = collapseCandidate{dir: c, norm: norm, depth: pathDepthNormalized(norm)}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].dir.SizeBytes == items[j].dir.SizeBytes {
			return items[i].depth > items[j].depth
		}
		return items[i].dir.SizeBytes > items[j].dir.SizeBytes
	})

	pruned := make([]bool, len(items))
	for i := range items {
		if pruned[i] {
			continue
		}
		ancestor := items[i]
		if ancestor.dir.SizeBytes <= 0 {
			continue
		}
		for j := range items {
			if i == j || pruned[j] {
				continue
			}
			child := items[j]
			if child.dir.SizeBytes <= 0 {
				continue
			}
			if !isDescendantNormalized(child.norm, ancestor.norm) {
				continue
			}
			if shouldPruneAncestorByDescendant(ancestor.dir, child.dir, descendantRatio) {
				pruned[i] = true
				break
			}
		}
	}

	result := make([]FilesystemLargestDirectory, 0, limit)
	for i := range items {
		if pruned[i] {
			continue
		}
		result = append(result, items[i].dir)
		if len(result) >= limit {
			break
		}
	}
	return result
}

// collapseCandidate carries a directory aggregate alongside its precomputed
// normalized path and depth so the pairwise ancestor scan never re-normalizes.
type collapseCandidate struct {
	dir   FilesystemLargestDirectory
	norm  string
	depth int
}

// isDescendantNormalized is isDescendantPath for paths already normalized via
// normalizePathForHierarchy — no per-call normalization.
func isDescendantNormalized(normalizedPath, normalizedAncestor string) bool {
	if normalizedPath == "" || normalizedAncestor == "" || normalizedPath == normalizedAncestor {
		return false
	}
	if normalizedAncestor == "/" {
		return strings.HasPrefix(normalizedPath, "/") && normalizedPath != "/"
	}
	if len(normalizedAncestor) == 3 && normalizedAncestor[1] == ':' && normalizedAncestor[2] == '/' {
		return strings.HasPrefix(normalizedPath, normalizedAncestor) && normalizedPath != normalizedAncestor
	}
	return strings.HasPrefix(normalizedPath, normalizedAncestor+"/")
}

// pathDepthNormalized is pathDepth for an already-normalized path.
func pathDepthNormalized(normalized string) int {
	if normalized == "" || normalized == "/" {
		return 0
	}
	depth := 0
	for _, part := range strings.Split(strings.Trim(normalized, "/"), "/") {
		if part != "" {
			depth++
		}
	}
	return depth
}

func shouldPruneAncestorByDescendant(
	ancestor FilesystemLargestDirectory,
	child FilesystemLargestDirectory,
	baseRatio float64,
) bool {
	if ancestor.SizeBytes <= 0 || child.SizeBytes <= 0 {
		return false
	}
	effectiveRatio := baseRatio
	if ancestor.Estimated && !child.Estimated {
		effectiveRatio = minFloat(effectiveRatio, 0.45)
	} else if ancestor.Estimated && child.Estimated {
		effectiveRatio = minFloat(effectiveRatio, 0.60)
	} else if !ancestor.Estimated && child.Estimated {
		effectiveRatio = maxFloat(effectiveRatio, 0.85)
	}
	return float64(child.SizeBytes) >= float64(ancestor.SizeBytes)*effectiveRatio
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func normalizePathForHierarchy(path string) string {
	normalized := strings.TrimSpace(strings.ReplaceAll(path, "\\", "/"))
	if normalized == "" {
		return ""
	}
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	if strings.HasSuffix(normalized, "/") && normalized != "/" {
		if !(len(normalized) == 3 && normalized[1] == ':') {
			normalized = strings.TrimSuffix(normalized, "/")
		}
	}
	return strings.ToLower(normalized)
}

func markDirAndAncestorsIncomplete(dirStats map[string]*fsDirAggregate, path string) {
	currentPath := path
	for currentPath != "" {
		agg, ok := dirStats[currentPath]
		if !ok {
			return
		}
		if agg.Incomplete {
			return
		}
		agg.Incomplete = true
		currentPath = agg.Parent
	}
}

func appendScanError(errors *[]FilesystemScanError, path string, err error, permissionDeniedCount *int64) {
	if err == nil {
		return
	}
	if os.IsPermission(err) {
		(*permissionDeniedCount)++
	}
	if len(*errors) >= maxFSErrors {
		return
	}
	*errors = append(*errors, FilesystemScanError{
		Path:  path,
		Error: err.Error(),
	})
}

func normalizePathForChecks(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	return strings.ToLower(path)
}

func classifyCleanupCategory(path string) string {
	n := normalizePathForChecks(path)
	switch {
	case strings.Contains(n, "/tmp/"),
		strings.HasSuffix(n, "/tmp"),
		strings.Contains(n, "/windows/temp/"),
		strings.Contains(n, "/appdata/local/temp/"),
		strings.Contains(n, "/var/tmp/"):
		return "temp_files"
	case strings.Contains(n, "/google/chrome/user data/"),
		strings.Contains(n, "/mozilla/firefox/"),
		strings.Contains(n, "/library/caches/com.apple.safari/"),
		strings.Contains(n, "/library/caches/"),
		strings.Contains(n, "/.cache/"),
		strings.Contains(n, "/edge/user data/"):
		return "browser_cache"
	case strings.Contains(n, "/var/cache/apt/"),
		strings.Contains(n, "/var/cache/dnf/"),
		strings.Contains(n, "/var/cache/yum/"),
		strings.Contains(n, "/library/caches/homebrew/"),
		strings.Contains(n, "/appdata/local/packages/"):
		return "package_cache"
	default:
		return ""
	}
}

func isOldDownload(path string, sizeBytes int64, modifiedAt time.Time, threshold time.Time) bool {
	if sizeBytes <= 0 {
		return false
	}
	if modifiedAt.After(threshold) {
		return false
	}
	n := normalizePathForChecks(path)
	if strings.Contains(n, "/library/caches/") ||
		strings.Contains(n, "/.cache/") ||
		strings.Contains(n, "/appdata/local/temp/") {
		return false
	}

	segments := strings.Split(strings.Trim(n, "/"), "/")
	for i, segment := range segments {
		if segment != "downloads" {
			continue
		}

		// macOS/Linux user download roots.
		if i >= 2 && (segments[0] == "users" || segments[0] == "home") {
			return true
		}

		// Windows path roots after slash normalization: c:/users/<user>/downloads
		if i >= 3 && strings.HasSuffix(segments[0], ":") && segments[1] == "users" {
			return true
		}
	}

	return false
}

func isUnrotatedLog(path string, sizeBytes int64) bool {
	if sizeBytes < unrotatedLogMinBytes {
		return false
	}
	n := normalizePathForChecks(path)
	return strings.HasSuffix(n, ".log")
}

func normalizeDuplicateName(name string) string {
	n := strings.TrimSpace(strings.ToLower(name))
	n = strings.ReplaceAll(n, " (copy)", "")
	n = strings.ReplaceAll(n, " - copy", "")
	return n
}

func addDuplicateCandidate(groups map[string]*duplicateGroup, path string, sizeBytes int64) {
	base := normalizeDuplicateName(filepath.Base(path))
	if base == "" || sizeBytes <= 0 {
		return
	}
	key := fmt.Sprintf("%d|%s", sizeBytes, base)
	group, ok := groups[key]
	if !ok {
		groups[key] = &duplicateGroup{
			Key:       key,
			SizeBytes: sizeBytes,
			Paths:     []string{path},
		}
		return
	}
	if len(group.Paths) < 50 {
		group.Paths = append(group.Paths, path)
	}
}

func buildDuplicateCandidateList(groups map[string]*duplicateGroup, limit int) []FilesystemDuplicateCandidate {
	candidates := make([]FilesystemDuplicateCandidate, 0, len(groups))
	for _, group := range groups {
		if len(group.Paths) < 2 {
			continue
		}
		candidates = append(candidates, FilesystemDuplicateCandidate{
			Key:       group.Key,
			SizeBytes: group.SizeBytes,
			Count:     len(group.Paths),
			Paths:     group.Paths,
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].SizeBytes == candidates[j].SizeBytes {
			return candidates[i].Count > candidates[j].Count
		}
		return candidates[i].SizeBytes > candidates[j].SizeBytes
	})
	if len(candidates) > limit {
		return candidates[:limit]
	}
	return candidates
}

func addCleanupCandidate(existing map[string]FilesystemCleanupCandidate, candidate FilesystemCleanupCandidate, maxItems int) {
	if len(existing) >= maxItems {
		return
	}
	if candidate.Path == "" || candidate.SizeBytes <= 0 {
		return
	}
	prev, ok := existing[candidate.Path]
	if !ok || candidate.SizeBytes > prev.SizeBytes {
		existing[candidate.Path] = candidate
	}
}

func mapCleanupCandidates(existing map[string]FilesystemCleanupCandidate, limit int) []FilesystemCleanupCandidate {
	candidates := make([]FilesystemCleanupCandidate, 0, len(existing))
	for _, candidate := range existing {
		candidates = append(candidates, candidate)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].SizeBytes > candidates[j].SizeBytes })
	if len(candidates) > limit {
		return candidates[:limit]
	}
	return candidates
}

func getTrashPaths() []string {
	paths := make([]string, 0, 12)
	seen := make(map[string]struct{})
	addPath := func(p string) {
		if p == "" {
			return
		}
		clean := filepath.Clean(p)
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		paths = append(paths, clean)
	}

	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		addPath(`C:\$Recycle.Bin`)
	case "darwin":
		if home != "" {
			addPath(filepath.Join(home, ".Trash"))
		}
		if entries, err := os.ReadDir("/Users"); err == nil {
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				name := entry.Name()
				if strings.HasPrefix(name, ".") {
					continue
				}
				addPath(filepath.Join("/Users", name, ".Trash"))
			}
		}
	case "linux":
		if home != "" {
			addPath(filepath.Join(home, ".local", "share", "Trash"))
		}
		if entries, err := os.ReadDir("/home"); err == nil {
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				name := entry.Name()
				if strings.HasPrefix(name, ".") {
					continue
				}
				addPath(filepath.Join("/home", name, ".local", "share", "Trash"))
			}
		}
		addPath(filepath.Join("/root", ".local", "share", "Trash"))
	}
	return paths
}

func estimateDirectorySize(root string, deadline time.Time, maxEntries int) (sizeBytes int64, filesScanned int64, timedOut bool, err error) {
	info, statErr := os.Stat(root)
	if statErr != nil {
		return 0, 0, false, statErr
	}
	if !info.IsDir() {
		return info.Size(), 1, false, nil
	}

	stack := []string{root}
	entries := 0

	for len(stack) > 0 {
		if time.Now().After(deadline) {
			return sizeBytes, filesScanned, true, nil
		}
		idx := len(stack) - 1
		current := stack[idx]
		stack = stack[:idx]

		children, readErr := os.ReadDir(current)
		if readErr != nil {
			if os.IsPermission(readErr) {
				continue
			}
			return sizeBytes, filesScanned, false, readErr
		}
		for _, child := range children {
			entries++
			if entries > maxEntries {
				return sizeBytes, filesScanned, true, nil
			}
			if time.Now().After(deadline) {
				return sizeBytes, filesScanned, true, nil
			}
			childPath := filepath.Join(current, child.Name())
			childInfo, infoErr := child.Info()
			if infoErr != nil {
				continue
			}
			if childInfo.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if childInfo.IsDir() {
				stack = append(stack, childPath)
				continue
			}
			size := childInfo.Size()
			if size < 0 {
				size = 0
			}
			sizeBytes += size
			filesScanned++
		}
	}

	return sizeBytes, filesScanned, false, nil
}
