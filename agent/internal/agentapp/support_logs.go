package agentapp

import (
	"io"
	"os"
	"sync"

	"github.com/breeze-rmm/agent/internal/logging"
)

// openLogFiles are the log files initLogging and initEnrollLogging opened.
// Only a support session releases them (releaseLogFiles); the installed agent
// keeps its log open for the life of the process.
var openLogFiles struct {
	mu    sync.Mutex
	files []io.Closer
}

func trackLogFile(f io.Closer) {
	openLogFiles.mu.Lock()
	openLogFiles.files = append(openLogFiles.files, f)
	openLogFiles.mu.Unlock()
}

// releaseLogFiles points logging at io.Discard and closes every log file this
// process opened. A support session calls it before removing its folder: on
// Windows an open file keeps the folder from being removed, and logging
// discarded from here on means nothing re-creates the log afterwards.
func releaseLogFiles() {
	logging.Init("text", "error", io.Discard)
	log = logging.L("main")

	openLogFiles.mu.Lock()
	files := openLogFiles.files
	openLogFiles.files = nil
	openLogFiles.mu.Unlock()
	for _, f := range files {
		_ = f.Close()
	}
}

// discardSupportWorkDir removes a support folder on an early exit (before the
// agent started), releasing the session log first so the removal can succeed
// on Windows.
func discardSupportWorkDir(workDir string) {
	releaseLogFiles()
	_ = os.RemoveAll(workDir)
}
