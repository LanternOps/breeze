package heartbeat

import "testing"

// The harness swaps the package seams (rebindNow, identitySyncNow, ...) in and
// back out around each test. A trigger (a tick, a source 401, a directive)
// drives the flow on its own goroutine, so the harness must not swap the
// seams back while one is still running: under -race, a tick right before
// the test returns raced the cleanup's write of identitySyncNow.
func TestRebindHarnessOutlivesTheFlowsGoroutines(t *testing.T) {
	t.Run("a tick right before the test ends", func(t *testing.T) {
		r := newRebindHarness(t)
		r.drive(r.directive(rebindGoldenIntent))
		r.waitRestarts(1)
		// Swapped: this drive reads identitySyncNow in retryRebindRestart.
		r.h.tickRebind()
	})
	t.Run("a source 401 right before the test ends", func(t *testing.T) {
		r := newRebindHarness(t)
		r.killAfter = "confirmed"
		r.drive(r.directive(rebindGoldenIntent))
		r.killAfter = ""
		r.restart()
		r.h.primeRebindState()
		r.h.noteSourceCredentialsRejected()
	})
}
