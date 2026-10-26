package unifi

import (
	"math"
	"time"
)

// statistics/latest request budget (spec §6.3). A persisted token bucket bounds
// the sustained rate; a per-poll cadence cap bounds each burst.
const (
	StatisticsTokenCapacity        = 16
	StatisticsTokenRefillPerMinute = 16
	MaxStatisticsRequestsPerPoll   = 16
)

// StatisticsCadenceBudget is min(16, max(1, floor(interval*16/60))). The interval
// is the collector's scheduling interval BEFORE the topology envelope's 60 s clamp.
func StatisticsCadenceBudget(pollIntervalSeconds int) int {
	b := pollIntervalSeconds * StatisticsTokenRefillPerMinute / 60
	if b < 1 {
		b = 1
	}
	if b > MaxStatisticsRequestsPerPoll {
		b = MaxStatisticsRequestsPerPoll
	}
	return b
}

// StatisticsPlan is one poll's reservation; nothing is persisted until Commit.
type StatisticsPlan struct {
	Budget  int
	Cursor  int
	balance float64
	at      time.Time
}

// PlanStatistics refills the bucket continuously (16/60 per second, capped at 16)
// and returns min(cadence budget, floor(available tokens)) plus the fair cursor.
func (s *TopologyState) PlanStatistics(now time.Time, pollIntervalSeconds int) StatisticsPlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	balance := float64(StatisticsTokenCapacity)
	if s.data.StatisticsTokens != nil {
		balance = *s.data.StatisticsTokens
		if elapsed := now.Sub(time.UnixMilli(s.data.StatisticsTokensAtMs)).Seconds(); elapsed > 0 {
			balance += elapsed * StatisticsTokenRefillPerMinute / 60
		}
		balance = math.Min(math.Max(balance, 0), StatisticsTokenCapacity)
	}
	budget := StatisticsCadenceBudget(pollIntervalSeconds)
	if avail := int(math.Floor(balance)); avail < budget {
		budget = avail
	}
	return StatisticsPlan{Budget: budget, Cursor: s.data.StatisticsCursor, balance: balance, at: now}
}

// CommitStatistics consumes one token per attempted request (failures and 404s
// included: they cost the controller a request) and persists the next cursor.
func (s *TopologyState) CommitStatistics(p StatisticsPlan, attempted, nextCursor int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	bal := math.Max(p.balance-float64(attempted), 0)
	next.StatisticsTokens, next.StatisticsTokensAtMs = &bal, p.at.UnixMilli()
	next.StatisticsCursor = nextCursor
	return s.save(next)
}
