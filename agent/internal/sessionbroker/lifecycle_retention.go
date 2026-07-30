package sessionbroker

import (
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// applyDisconnectedRetention caps how long a SYSTEM-role helper stays desired
// for a disconnected session that retainDisconnectedSystemHelper says should be
// retained (an RDP session, or on an RDS host any disconnected non-console
// session — see retainDisconnectedSystemHelper for why Type isn't trustworthy
// there). helperRoleDesired retains those helpers deliberately (the session
// keeps running when disconnected), but with no age limit they accumulate on
// terminal servers where disconnected sessions linger for days. seen maps
// Windows session ID → when this function first observed the session
// disconnected; it is mutated in place — entries are added on first sighting
// and dropped when the session leaves the disconnected state or the snapshot.
// desired is pruned in place once a session has been disconnected for ttl or
// longer.
func applyDisconnectedRetention(desired map[HelperKey]bool, sessions []DetectedSession, seen map[uint32]time.Time, now time.Time, ttl time.Duration, rdsHost bool, consoleSessionID string) {
	disconnected := make(map[uint32]bool, len(seen))
	for _, s := range sessions {
		if !retainDisconnectedSystemHelper(s, rdsHost, consoleSessionID) {
			continue
		}
		id64, err := strconv.ParseUint(s.Session, 10, 32)
		if err != nil || id64 == 0 {
			continue
		}
		id := uint32(id64)
		disconnected[id] = true
		since, ok := seen[id]
		if !ok {
			seen[id] = now
			continue
		}
		if now.Sub(since) >= ttl {
			log.Info("retention: pruning SYSTEM helper for long-disconnected non-console session", "session", id, "disconnectedFor", now.Sub(since).String())
			delete(desired, HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem})
		}
	}
	for id := range seen {
		if !disconnected[id] {
			delete(seen, id)
		}
	}
}
