package isolation

import (
	"fmt"
	"os"
	"time"
)

// processStart anchors the fallback clock when the OS monotonic clock or boot
// identity cannot be read.
var processStart = time.Now()

// processMono is monotonic only within this process.
func processMono() time.Duration { return time.Since(processStart) }

// processBootID scopes the monotonic expiry clause to this process, so it is
// never compared across a restart it cannot vouch for.
func processBootID() string {
	return fmt.Sprintf("process:%d:%d", os.Getpid(), processStart.UnixNano())
}
