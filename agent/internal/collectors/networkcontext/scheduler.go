package networkcontext

import (
	"sync"
	"time"
)

// Scheduler is driven by the existing heartbeat loop and OS event callbacks.
// Begin, including startup, is the only collection admission point.
type Scheduler struct {
	mu           sync.Mutex
	nextPeriodic time.Time
	eventDue     time.Time
	lastExtra    time.Time
	running      bool
	jitter       func() float64
}

func NewScheduler(jitter func() float64) *Scheduler {
	if jitter == nil {
		jitter = func() float64 { return .5 }
	}
	return &Scheduler{jitter: jitter}
}
func (s *Scheduler) Notify(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eventDue = now.Add(10 * time.Second)
}
func (s *Scheduler) Begin(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	periodic := s.nextPeriodic.IsZero() || !now.Before(s.nextPeriodic)
	event := !s.eventDue.IsZero() && !now.Before(s.eventDue) && (s.lastExtra.IsZero() || !now.Before(s.lastExtra.Add(time.Minute)))
	if !periodic && !event {
		return false
	}
	s.running = true
	if periodic {
		fraction := s.jitter()
		if fraction < 0 {
			fraction = 0
		}
		if fraction > 1 {
			fraction = 1
		}
		s.nextPeriodic = now.Add(time.Duration(float64(5*time.Minute) * (.9 + .2*fraction)))
	} else {
		s.lastExtra = now
	}
	if event || periodic {
		s.eventDue = time.Time{}
	}
	return true
}
func (s *Scheduler) Finish() { s.mu.Lock(); s.running = false; s.mu.Unlock() }
