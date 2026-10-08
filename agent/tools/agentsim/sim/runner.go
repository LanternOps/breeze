package sim

import (
	"context"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"
)

type deviceList struct {
	mu  sync.Mutex
	ids []string
}

func (d *deviceList) add(id string) {
	if id == "" {
		return
	}
	d.mu.Lock()
	d.ids = append(d.ids, id)
	d.mu.Unlock()
}

func (d *deviceList) snapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.ids...)
}

// Run executes one simulator run and always writes its report, including
// when ctx is cancelled (Ctrl-C) before the steady window opens.
func Run(ctx context.Context, cfg Config) (Report, error) {
	if err := cfg.Validate(); err != nil {
		return Report{}, err
	}
	cfg.ServerURL = strings.TrimRight(cfg.ServerURL, "/")
	if err := checkFileLimit(cfg.Agents); err != nil {
		return Report{}, err
	}
	store, err := LoadStore(cfg.StorePath, cfg.ServerURL, cfg.HostnamePrefix)
	if err != nil {
		return Report{}, err
	}
	if missing := store.Missing(cfg.Agents); missing > 0 && cfg.EnrollmentKey == "" {
		return Report{}, fmt.Errorf("%d of %d agents are not in %s and no --enrollment-key (AGENTSIM_ENROLLMENT_KEY) was given", missing, cfg.Agents, cfg.StorePath)
	}

	start := time.Now()
	open, closeAt := cfg.SteadyWindow()
	rec := NewRecorder(start.UTC().Format("20060102T150405Z")+"-"+randomTag(), start, start.Add(open), start.Add(closeAt))
	enroller := &Enroller{
		ServerURL: cfg.ServerURL, Key: cfg.EnrollmentKey, Secret: cfg.EnrollmentSecret,
		AgentVersion: cfg.AgentVersion, OSType: cfg.OSType,
		Client: &http.Client{Timeout: cfg.RequestTimeout,
			Transport: &recordingTransport{base: http.DefaultTransport.(*http.Transport).Clone(), rec: rec}},
	}
	reenroll := func(ctx context.Context, old Identity) (Identity, error) {
		fresh, err := enroller.Enroll(ctx, old.Index, store.ReenrollHostname(old.Index))
		if err != nil {
			rec.EnrollFailed()
			return Identity{}, err
		}
		store.Put(fresh)
		rec.Reenrolled()
		return fresh, nil
	}

	runCtx, cancel := context.WithDeadline(ctx, start.Add(cfg.Duration))
	defer cancel()

	go func() { // a crash mid-run must not lose 2,000 enrollments
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-t.C:
				_ = store.Save(cfg.StorePath)
			}
		}
	}()

	var (
		wg      sync.WaitGroup
		started atomic.Int64
		devices deviceList
	)
	sem := make(chan struct{}, cfg.EnrollConcurrency)
	if cfg.Commander.PerMinute > 0 {
		jar, _ := cookiejar.New(nil) // the login's auth-binding handshake needs the cookie back
		cmd := &Commander{ServerURL: cfg.ServerURL, Cfg: cfg.Commander, Client: &http.Client{Timeout: cfg.RequestTimeout, Jar: jar},
			Rec: rec, DeviceIDs: devices.snapshot}
		wg.Add(1)
		go func() { defer wg.Done(); _ = cmd.Run(runCtx) }()
	}
	ramp := rate.NewLimiter(rate.Limit(cfg.RampPerSecond), 1)
	for i := 0; i < cfg.Agents; i++ {
		if ramp.Wait(runCtx) != nil {
			break
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, ok := store.Get(i)
			if ok {
				rec.EnrollReused()
			} else {
				select {
				case sem <- struct{}{}:
				case <-runCtx.Done():
					return
				}
				var err error
				id, err = enroller.Enroll(runCtx, i, store.Hostname(i))
				<-sem
				if err != nil {
					rec.EnrollFailed()
					return
				}
				store.Put(id)
				rec.Enrolled()
			}
			started.Add(1)
			devices.add(id.DeviceID)
			NewAgent(&cfg, rec, id, reenroll).Run(runCtx)
		}(i)
	}
	<-runCtx.Done()
	wg.Wait()
	ended := time.Now()

	saveErr := store.Save(cfg.StorePath)
	report := BuildReport(rec, cfg, ended, int(started.Load()))
	if err := WriteReport(cfg.ReportPath, report); err != nil {
		return report, fmt.Errorf("write report: %w", err)
	}
	if saveErr != nil {
		return report, fmt.Errorf("save token store: %w", saveErr)
	}
	return report, nil
}
