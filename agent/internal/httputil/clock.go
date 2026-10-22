package httputil

import (
	"math/rand/v2"
	"sync/atomic"
	"time"
)

// Time and randomness seams for Do's waits (W09, #8148). Swapped only by tests
// (installFakeRetryClock), which must not call t.Parallel().
var (
	nowFn     = time.Now
	afterFn   = time.After
	randFloat = rand.Float64
)

// loopRetryAfterDisabled is the D10 escape hatch (config key
// loop_retry_after=false). The zero value means enabled.
var loopRetryAfterDisabled atomic.Bool

// SetLoopRetryAfter turns loop-level Retry-After handling on (the default) or
// off. Off restores the pre-W09 behaviour: Do sleeps toward a server's
// Retry-After even when it outlives the caller's context, and errors carry no
// RetryAt, so no caller defers its next cycle. Call it once at agent start,
// before any loop runs.
func SetLoopRetryAfter(enabled bool) { loopRetryAfterDisabled.Store(!enabled) }

// LoopRetryAfterEnabled reports the current setting.
func LoopRetryAfterEnabled() bool { return !loopRetryAfterDisabled.Load() }
