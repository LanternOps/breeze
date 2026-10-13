package tools

import (
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/wire"
)

// One filesystem_analysis scan at a time per agent (#8509).
//
// AnalyzeFilesystem starts a pool of up to 8 enumeration workers (32 if the
// payload asks). Two scans arriving together — a technician's scan, the AI
// disk tool, a disk-threshold trigger, an auto-resume continuation — used to
// run two pools side by side against the same volume. On a domain controller
// that doubled metadata I/O was reported alongside 40–149 s VSS writer freezes.
// The second scan never produces better data than the first, so it is refused
// with a typed code naming the scan that is running, not started.

type inFlightFilesystemScan struct {
	CommandID string
	StartedAt time.Time
}

type filesystemScanGate struct {
	mu      sync.Mutex
	running *inFlightFilesystemScan
}

// defaultFilesystemScanGate is the agent-wide slot. Package-level because the
// constraint is per process: every command handler reaches the same disks.
var defaultFilesystemScanGate = &filesystemScanGate{}

// tryBegin claims the slot. When it is already held, it returns the holder
// (a copy) and a nil release. The release func is idempotent.
func (g *filesystemScanGate) tryBegin(commandID string, now time.Time) (func(), *inFlightFilesystemScan) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.running != nil {
		holder := *g.running
		return nil, &holder
	}
	mine := &inFlightFilesystemScan{CommandID: commandID, StartedAt: now}
	g.running = mine
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			if g.running == mine {
				g.running = nil
			}
			g.mu.Unlock()
		})
	}, nil
}

func scanInProgressError(running *inFlightFilesystemScan, now time.Time) error {
	id := running.CommandID
	if id == "" {
		id = "unknown"
	}
	elapsed := now.Sub(running.StartedAt).Truncate(time.Second)
	return errorCodef(wire.ErrCodeScanInProgress,
		"filesystem analysis already in progress on this device (command %s, running for %s); not starting a second scan",
		id, elapsed)
}

func runGatedFilesystemAnalysis(
	gate *filesystemScanGate,
	commandID string,
	payload map[string]any,
	scan func(map[string]any) CommandResult,
) CommandResult {
	start := time.Now()
	release, running := gate.tryBegin(commandID, start)
	if running != nil {
		return NewErrorResult(scanInProgressError(running, start), time.Since(start).Milliseconds())
	}
	defer release()
	return scan(payload)
}

// AnalyzeFilesystemCommand is the command-handler entry point: AnalyzeFilesystem
// behind the agent-wide one-scan-at-a-time gate.
func AnalyzeFilesystemCommand(commandID string, payload map[string]any) CommandResult {
	return runGatedFilesystemAnalysis(defaultFilesystemScanGate, commandID, payload, AnalyzeFilesystem)
}
