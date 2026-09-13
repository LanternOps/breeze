package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/config"
)

// warrantyCollectionConfigKey is the agent.yaml key the pushed flag persists to.
const warrantyCollectionConfigKey = "hp_warranty_collection_enabled"

// persistWarrantyCollectionEnabled is the seam to the on-disk write. A package
// var so tests can capture the resolved bool on any platform without a config
// file present — the dispatch + payload-parse path is where a key-name
// regression would silently disable the whole feature, so it must be
// unit-tested even though viper.WriteConfig cannot run on the CI agent.
var persistWarrantyCollectionEnabled = setWarrantyCollectionEnabled

func setWarrantyCollectionEnabled(enabled bool) error {
	return config.SetAndPersist(warrantyCollectionConfigKey, enabled)
}

// applyWarrantyConfig handles the warranty_settings block from the heartbeat
// config update (#5511 W02). True permits device-side HP warranty collection
// via HP's CMSL; false stops it — which is what a device with no warranty
// policy, or one whose nearest policy dropped the hpCmsl block, receives. The
// server omits the block entirely when it could not resolve, so an absent key
// means "no change", never "off".
//
// The API sends snake_case inside the block; camelCase is accepted first here
// to match patch_source.go's parse, and both spellings are covered by tests.
func (h *Heartbeat) applyWarrantyConfig(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		log.Warn("ignoring invalid warranty_settings payload: not an object")
		return
	}

	v, present := m["hpCmslEnabled"]
	if !present {
		v, present = m["hp_cmsl_enabled"]
	}
	if !present {
		log.Warn("warranty_settings received without hpCmslEnabled field")
		return
	}
	enabled, ok := v.(bool)
	if !ok {
		log.Warn("ignoring warranty_settings: hpCmslEnabled is not a boolean")
		return
	}

	h.mu.Lock()
	changed := h.config.HPWarrantyCollectionEnabled != enabled
	h.config.HPWarrantyCollectionEnabled = enabled
	h.mu.Unlock()

	// The in-memory value is what the collector reads, so it is always updated.
	// Only a CHANGE is written to disk: this runs on every heartbeat, and
	// rewriting agent.yaml each minute would be pointless churn.
	if !changed {
		return
	}

	if err := persistWarrantyCollectionEnabled(enabled); err != nil {
		// Keep the in-memory value. The control plane's instruction still
		// applies for this process and is re-persisted the next time it
		// changes; reverting here would ignore a live instruction because a
		// file write failed.
		log.Warn("failed to persist hp_warranty_collection_enabled", "error", err.Error())
		return
	}
	if enabled {
		log.Info("HP CMSL warranty collection enabled by control plane")
	} else {
		log.Info("HP CMSL warranty collection disabled by control plane")
	}
}

// hpWarrantyCollectionEnabled reads the flag under h.mu. The (W03) collector
// calls this rather than reading h.config directly, so a value pushed mid-run
// takes effect on the next collection with no restart.
func (h *Heartbeat) hpWarrantyCollectionEnabled() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.config.HPWarrantyCollectionEnabled
}
