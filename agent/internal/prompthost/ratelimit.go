package prompthost

import "time"

// cardLimiter caps new cards per session: at most 10 in any 10 minutes.
// Beyond that a new prompt goes to the list only (it is still delivered and
// findable, it just does not draw another window).
type cardLimiter struct {
	seen map[string][]time.Time
}

func newCardLimiter() *cardLimiter { return &cardLimiter{seen: map[string][]time.Time{}} }

// allow records a new card for owner and reports whether it may be drawn.
func (l *cardLimiter) allow(ownerKey string, now time.Time) bool {
	recent := l.seen[ownerKey][:0]
	for _, at := range l.seen[ownerKey] {
		if now.Sub(at) < cardWindow {
			recent = append(recent, at)
		}
	}
	if len(recent) >= cardsPerWindow {
		l.seen[ownerKey] = recent
		return false
	}
	l.seen[ownerKey] = append(recent, now)
	return true
}
