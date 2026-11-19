package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/wakeconfig"
)

// Of the wake_on_lan_settings block only `enabled` and the boolean
// `configure_settings` are read. firmware_writes is ignored on purpose (it
// arrives with the Dell write wave), and no field can name a setting or value:
// the writable settings are a compile-time list in wakeconfig. Writes stay
// inactive until wakeconfig's activation switch is flipped, so in this release
// configure_settings true is carried but never reaches a writer.

// parseWakeSettings reads wake_on_lan_settings in snake_case or camelCase. A
// non-object, or a missing or non-boolean `enabled`, is rejected. Anything but
// a boolean true for configure_settings reads as false.
func parseWakeSettings(raw any) (wakeconfig.Settings, bool) {
	m, ok := raw.(map[string]any)
	if !ok {
		return wakeconfig.Settings{}, false
	}
	enabled, ok := m["enabled"].(bool)
	if !ok {
		return wakeconfig.Settings{}, false
	}
	cfg, present := m["configure_settings"]
	if !present {
		cfg = m["configureSettings"]
	}
	configure, _ := cfg.(bool)
	return wakeconfig.Settings{Enabled: enabled, ConfigureSettings: configure}, true
}

// applyWakeOnLanSettings hands a parsed block to the manager. An invalid
// payload is ignored and the previous state stays. It never blocks.
func (h *Heartbeat) applyWakeOnLanSettings(raw any) {
	s, ok := parseWakeSettings(raw)
	if !ok {
		log.Warn("ignoring invalid wake_on_lan_settings; previous state stays in force", "payload", raw)
		return
	}
	if h.wakeApply != nil {
		h.wakeApply(s)
		return
	}
	if h.wake != nil {
		h.wake.ApplySettings(s)
	}
}

// applyWakeOnLanFromUpdate looks the block up in a config update. An absent
// block (the server omits it on a resolver error) means no change.
func (h *Heartbeat) applyWakeOnLanFromUpdate(update map[string]any) {
	raw, ok := update["wake_on_lan_settings"]
	if !ok {
		raw, ok = update["wakeOnLanSettings"]
	}
	if ok {
		h.applyWakeOnLanSettings(raw)
	}
}

// wakeUpload carries the manager's context to sendInventoryData while
// serializing exactly as the snapshot it wraps.
type wakeUpload struct {
	ctx  context.Context
	snap wakeconfig.Snapshot
}

func (p wakeUpload) MarshalJSON() ([]byte, error) { return json.Marshal(p.snap) }

// wakeFirstDelay keeps the first collection off the boot path and spreads a
// fleet that booted together: 60 s plus up to 60 s, deterministic per agent.
func wakeFirstDelay(id string) time.Duration {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id + ":wake-status"))
	return time.Minute + time.Duration(h.Sum64()%uint64(time.Minute+1))
}

func (h *Heartbeat) initWake() {
	h.wake = wakeconfig.New(h.wakeOptions())
}

// wakeOptions is the production wiring. Writer is nil off Windows; on Windows
// it is only ever called once wakeconfig's activation switch is on.
func (h *Heartbeat) wakeOptions() wakeconfig.Options {
	return wakeconfig.Options{
		Collect: h.collectWakeInputs,
		Upload: func(ctx context.Context, s wakeconfig.Snapshot) error {
			return h.sendInventoryData("wake-status", wakeUpload{ctx: ctx, snap: s}, "wake status")
		},
		StatePath:  wakeconfig.DefaultStatePath(),
		FirstDelay: wakeFirstDelay(h.config.AgentID),
		Writer:     wakeconfig.NewWriter(),
		Reread:     wakeconfig.CollectWindows,
		BootID:     wakeconfig.BootID,
	}
}

// collectWakeInputs gathers the Windows readings first (unsupported OSes stop
// there, before any hardware collection runs), then manufacturer and model.
func (h *Heartbeat) collectWakeInputs(ctx context.Context) (wakeconfig.Inputs, error) {
	readings, err := wakeconfig.CollectWindows(ctx)
	if err != nil {
		return wakeconfig.Inputs{}, err
	}
	collect := h.hardwareCollectFn
	if collect == nil {
		if h.hardwareCol == nil {
			return wakeconfig.Inputs{}, fmt.Errorf("hardware collector unavailable")
		}
		collect = h.hardwareCol.CollectHardware
	}
	hw, err := collectors.Guard("hardware", collect)
	if err != nil {
		return wakeconfig.Inputs{}, fmt.Errorf("hardware identity: %w", err)
	}
	virt := collectors.ClassifyVirtualization(hw)
	return wakeconfig.Inputs{
		OS:           runtime.GOOS,
		Manufacturer: hw.Manufacturer,
		Model:        hw.Model,
		Virtual:      virt.IsVirtual,
		Windows:      readings,
		Firmware:     biosconfig.Detect(hw.Manufacturer, hw.Model),
	}, nil
}

func (h *Heartbeat) startWake() {
	m := h.wake
	if m == nil {
		return
	}
	m.Start(context.Background())
	h.inventoryWg.Add(1)
	go func() {
		defer h.inventoryWg.Done()
		<-m.Done()
	}()
}

// stopWake cancels any in-flight collection or upload. It must run before
// inventoryWg.Wait so a blocked cycle unblocks.
func (h *Heartbeat) stopWake() {
	if h.wake != nil {
		h.wake.Stop()
	}
}
