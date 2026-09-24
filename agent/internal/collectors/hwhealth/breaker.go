package hwhealth

import "time"

type breaker struct {
	failures  int
	retryAt   time.Time
	lastError string
}

func (b *breaker) blocked(now time.Time) bool { return now.Before(b.retryAt) }

func (b *breaker) finish(now time.Time, err error) {
	if err == nil {
		*b = breaker{}
		return
	}
	b.failures++
	b.lastError = err.Error()
	if b.failures >= 3 {
		b.retryAt = now.Add(6 * time.Hour)
	}
}
