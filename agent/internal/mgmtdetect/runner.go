package mgmtdetect

import (
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("mgmtdetect")

// CollectPosture runs the full management posture scan.
func CollectPosture() ManagementPosture {
	start := time.Now()

	posture := ManagementPosture{
		CollectedAt: start.UTC(),
		Categories:  make(map[Category][]Detection),
	}

	// Take process snapshot once
	snap, err := newProcessSnapshot()
	if err != nil {
		posture.Errors = append(posture.Errors, "process snapshot: "+err.Error())
		snap = &processSnapshot{names: make(map[string]bool)}
	}

	dispatcher := newCheckDispatcher(snap)

	// Evaluate all signatures
	sigs := AllSignatures()
	goos := runtime.GOOS

	for _, sig := range sigs {
		if !sig.MatchesOS(goos) {
			continue
		}

		detection, matched := evaluateSignature(dispatcher, sig)
		if matched {
			posture.Categories[sig.Category] = append(posture.Categories[sig.Category], detection)
		}
	}

	// Run deep detectors concurrently
	var wg sync.WaitGroup
	var mu sync.Mutex

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				mu.Lock()
				posture.Errors = append(posture.Errors, fmt.Sprintf("identity detection panic: %v", r))
				mu.Unlock()
				log.Error("panic in identity detection", "error", r)
			}
		}()
		id := collectIdentityStatus()
		mu.Lock()
		posture.Identity = id
		mu.Unlock()
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			if r := recover(); r != nil {
				mu.Lock()
				posture.Errors = append(posture.Errors, fmt.Sprintf("policy detection panic: %v", r))
				mu.Unlock()
				log.Error("panic in policy detection", "error", r)
			}
		}()
		policyDetections := collectPolicyDetections()
		if len(policyDetections) > 0 {
			mu.Lock()
			posture.Categories[CategoryPolicyEngine] = append(
				posture.Categories[CategoryPolicyEngine], policyDetections...)
			mu.Unlock()
		}
	}()

	wg.Wait()

	posture.ScanDurationMs = time.Since(start).Milliseconds()
	log.Info("management posture scan complete",
		"duration_ms", posture.ScanDurationMs,
		"detections", countDetections(posture),
		"errors", len(posture.Errors))

	return posture
}

// evaluateSignature evaluates a single tool signature.
func evaluateSignature(d *checkDispatcher, sig Signature) (Detection, bool) {
	det := Detection{
		Name:   sig.Name,
		Status: StatusInstalled,
	}

	for _, check := range sig.Checks {
		if d.evaluate(check) {
			switch check.Type {
			case CheckServiceRunning, CheckProcessRunning:
				det.Status = StatusActive
				if check.Type == CheckServiceRunning {
					det.ServiceName = check.Value
				}
			}

			if sig.Version != nil {
				det.Version = extractVersion(d, *sig.Version)
			}

			return det, true
		}
	}

	return Detection{}, false
}

// TODO: extractVersion is a stub - version extraction from command output is not yet implemented.
func extractVersion(d *checkDispatcher, vc Check) string {
	return ""
}

func countDetections(p ManagementPosture) int {
	total := 0
	for _, dets := range p.Categories {
		total += len(dets)
	}
	return total
}
