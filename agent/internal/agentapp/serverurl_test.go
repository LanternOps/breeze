package agentapp

import (
	"sync"
	"testing"
)

// Before the heartbeat exists the provider serves the startup config value —
// the shipper is initialized first on purpose (startup diagnostics must ship).
func TestServerURLProviderUsesStartupURLBeforeBind(t *testing.T) {
	p := newServerURLProvider("https://primary.example.com")
	if got, want := p.Get(), "https://primary.example.com"; got != want {
		t.Fatalf("Get() before Bind = %q, want %q", got, want)
	}
}

// After Bind, every read goes through the heartbeat's getter, so a
// backup-server-URL promotion (#2323) is visible to the shipper (#2463).
func TestServerURLProviderFollowsBoundGetter(t *testing.T) {
	p := newServerURLProvider("https://primary.example.com")

	promoted := "https://primary.example.com"
	p.Bind(func() string { return promoted })

	if got, want := p.Get(), "https://primary.example.com"; got != want {
		t.Fatalf("Get() after Bind = %q, want %q", got, want)
	}

	promoted = "https://backup.example.com" // heartbeat promotes the backup

	if got, want := p.Get(), "https://backup.example.com"; got != want {
		t.Fatalf("Get() after promotion = %q, want %q — the shipper must not hold a stale copy (#2463)", got, want)
	}
}

// Bind(nil) must not blank the URL. A nil func() string stored and then called
// would panic inside the shipper's goroutine — the hazard PR #2454 fixed in
// the sibling clients — so it is ignored and the startup value is kept.
func TestServerURLProviderIgnoresNilBind(t *testing.T) {
	p := newServerURLProvider("https://primary.example.com")
	p.Bind(nil)

	if got, want := p.Get(), "https://primary.example.com"; got != want {
		t.Fatalf("Get() after Bind(nil) = %q, want %q", got, want)
	}
}

// Bind happens on the startup goroutine while the shipper reads from its own;
// -race must be clean.
func TestServerURLProviderConcurrentBindAndGet(t *testing.T) {
	p := newServerURLProvider("https://primary.example.com")

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		p.Bind(func() string { return "https://backup.example.com" })
	}()

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				if got := p.Get(); got == "" {
					t.Errorf("Get() returned empty URL")
					return
				}
			}
		}()
	}
	wg.Wait()
}
