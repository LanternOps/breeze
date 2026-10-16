package ech

import (
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/netcache"
)

var (
	// sharedMu guards shared. A plain mutex (rather than sync.Once) lets
	// SetSharedForTest swap the singleton race-free; Shared is called once per
	// transport build and once per heartbeat, never per dial.
	sharedMu sync.Mutex
	shared   *Dialer
)

// Shared is the process-wide ECH dialer. Like netcache.Shared it does not
// create the data dir; the agent does at startup. It deliberately does not
// touch the config package (Load takes a non-reentrant lock and rebinds the
// global viper instance). It starts with both flags true; each process must
// call Configure(cfg.ECH, cfg.ECHServerEnabled) with the config it already
// holds.
func Shared() *Dialer {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	if shared == nil {
		// DoH dials through netcache too (cached-IP fallback when system DNS
		// fails) but keeps its own TLS: it never goes through the ECH dialer.
		dohTransport := http.DefaultTransport.(*http.Transport).Clone()
		dohTransport.DialContext = netcache.Shared().DialContext
		shared = New(Options{
			TCPDial:       netcache.Shared().DialContext,
			Resolver:      NewResolver(&http.Client{Timeout: 3 * time.Second, Transport: dohTransport}),
			Cache:         NewCache(filepath.Join(config.GetDataDir(), "ech-cache.json")),
			LocalEnabled:  true,
			ServerEnabled: true,
		})
	}
	return shared
}

// Configure updates the shared dialer's flags (e.g. after a config reload).
func Configure(local, server bool) {
	d := Shared()
	d.SetLocalEnabled(local)
	d.SetServerEnabled(server)
}
