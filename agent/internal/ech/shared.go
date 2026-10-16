package ech

import (
	"path/filepath"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/netcache"
)

var (
	sharedOnce sync.Once
	shared     *Dialer
)

// Shared is the process-wide ECH dialer. Like netcache.Shared it does not
// create the data dir; the agent does at startup. A config load error leaves
// both flags at their default (true).
func Shared() *Dialer {
	sharedOnce.Do(func() {
		local, server := true, true
		if cfg, err := config.Load(""); err == nil {
			local, server = cfg.ECH, cfg.ECHServerEnabled
		}
		shared = New(Options{
			TCPDial:       netcache.Shared().DialContext,
			Cache:         NewCache(filepath.Join(config.GetDataDir(), "ech-cache.json")),
			LocalEnabled:  local,
			ServerEnabled: server,
		})
	})
	return shared
}

// Configure updates the shared dialer's flags (e.g. after a config reload).
func Configure(local, server bool) {
	d := Shared()
	d.SetLocalEnabled(local)
	d.SetServerEnabled(server)
}
