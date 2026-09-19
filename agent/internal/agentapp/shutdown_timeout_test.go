package agentapp

import (
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
)

type shutdownRoundTripper func(*http.Request) (*http.Response, error)

func (f shutdownRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRunWithTimeoutBoundsBlockedShipperFlush(t *testing.T) {
	logging.Init("text", "info", io.Discard)
	defer logging.Init("text", "info", nil)
	token := secmem.NewSecureString("test-token")
	defer token.Zero()
	flushing := make(chan struct{})
	release := make(chan struct{})
	stopped := make(chan struct{})
	returned := make(chan struct{})
	logging.InitShipper(logging.ShipperConfig{
		ServerURL: func() string { return "https://agent.example.com" },
		AgentID:   "test-agent", AuthToken: token,
		HTTPClient: &http.Client{Transport: shutdownRoundTripper(func(*http.Request) (*http.Response, error) {
			close(flushing)
			<-release
			return &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody}, nil
		})},
	})
	defer func() {
		close(release)
		<-stopped
		<-returned
	}()
	log.Warn("queued shutdown log")
	go func() {
		runWithTimeout("log shipper flush", 50*time.Millisecond, func() {
			logging.StopShipper()
			close(stopped)
		})
		close(returned)
	}()
	select {
	case <-flushing:
	case <-time.After(time.Second):
		t.Fatal("shipper did not start its final flush")
	}
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("shutdown deadline warning blocked behind the log shipper flush")
	}
}

func TestRunWithTimeoutReturnsQuicklyWhenFnIsFast(t *testing.T) {
	start := time.Now()
	runWithTimeout("fast", 5*time.Second, func() {
		time.Sleep(10 * time.Millisecond)
	})
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("expected fast return, took %v", elapsed)
	}
}

func TestRunWithTimeoutAbandonsHungFn(t *testing.T) {
	done := make(chan struct{})
	defer close(done)

	start := time.Now()
	runWithTimeout("hung", 100*time.Millisecond, func() {
		<-done // blocks until test end
	})
	elapsed := time.Since(start)
	if elapsed < 100*time.Millisecond {
		t.Fatalf("returned before timeout: %v", elapsed)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("exceeded timeout by too much: %v", elapsed)
	}
}
