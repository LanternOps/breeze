package wakeconfig

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

// writesActivated is the agent-side switch for every wake setting write. It
// stays false until the activation wave (W06), which flips it in the same PR
// that lets a policy deliver configure_settings true. Until then a delivered
// configure_settings true is parsed but never reaches a Writer. Tests in this
// package enable writes through Options.testAllowWrites, which no other
// package can set.
const writesActivated = false

// OpKind is one Windows or NIC setting Breeze can change. The list is fixed at
// compile time: nothing from the server names a setting or a value.
type OpKind int

const (
	OpFastStartupOff OpKind = iota + 1 // HiberbootEnabled = 0
	OpMagicPacketOn                    // WakeOnMagicPacket = Enabled, -NoRestart
	OpEEEOff                           // *EEE = 0, -NoRestart
	OpShutdownWakeOn                   // Realtek S5WakeOnLan = 1, -NoRestart
)

func (k OpKind) String() string {
	switch k {
	case OpFastStartupOff:
		return "fast_startup"
	case OpMagicPacketOn:
		return "magic_packet"
	case OpEEEOff:
		return "eee"
	case OpShutdownWakeOn:
		return "shutdown_wake"
	}
	return fmt.Sprintf("op(%d)", int(k))
}

// needsReboot: NIC writes use -NoRestart, so the stored value is not in effect
// until the adapter restarts, which Breeze never does; the next boot does.
// Fast Startup is read at shutdown, so the next shutdown is already full.
func (k OpKind) needsReboot() bool { return k != OpFastStartupOff }

// Op is one write: a kind and, for NIC kinds, the adapter's MAC.
type Op struct {
	Kind OpKind
	MAC  string
}

// Key identifies the setting for the limiter and pending state.
func (o Op) Key() string {
	if o.Kind == OpFastStartupOff {
		return o.Kind.String()
	}
	return "nic:" + o.MAC + ":" + o.Kind.String()
}

// Writer performs one write. It does not read back; Apply re-reads.
type Writer interface {
	Write(ctx context.Context, op Op) error
}

// ApplyState is persisted in the wake status state file.
type ApplyState struct {
	Limiter Limiter `json:"limiter"`
	// Pending maps a setting key to when it was written. It clears only at a
	// boot later than the write, or when the value drifts.
	Pending         map[string]time.Time `json:"pending,omitempty"`
	LastApplyAt     time.Time            `json:"lastApplyAt,omitzero"`
	LastApplyResult string               `json:"lastApplyResult,omitempty"`
}

// ApplyStatus is what Compute needs to report needs_reboot / apply_failed.
type ApplyStatus struct {
	Configure       bool
	Pending         []string
	Failed          []string // last attempt failed and the value is still wrong
	Blocked         []string // stopped after maxFailures
	Deferred        []string // wrong, waiting for the 24 h limit
	LastApplyAt     time.Time
	LastApplyResult string // ok | partial | failed
}

// ApplyInputs is everything one Apply pass needs.
type ApplyInputs struct {
	// Configure is the delivered configure_settings after the activation gate.
	Configure         bool
	PolicyFingerprint string
	Virtual           bool
	Readings          *WindowsReadings
	// Memory is the remembered wired adapter set; a remembered adapter is
	// enough to justify turning Fast Startup off on an undocked laptop.
	Memory AdapterMemory
	Reread func(ctx context.Context) (*WindowsReadings, error)
	Writer Writer
	State  *ApplyState
	// Persist saves the state. It must succeed before each write runs.
	Persist  func(ApplyState) error
	BootTime func() (time.Time, error)
	Now      time.Time
}

// ApplyReport is the result of one pass.
type ApplyReport struct {
	Readings  *WindowsReadings // the re-read after writes, else the input
	Attempted []string
	Failed    map[string]string // key -> write_error | readback_mismatch | readback_unavailable
	Status    ApplyStatus
}

// BootTime returns the last boot time of this machine.
func BootTime() (time.Time, error) {
	s, err := host.BootTime()
	if err != nil {
		return time.Time{}, err
	}
	if s == 0 {
		return time.Time{}, fmt.Errorf("boot time unavailable")
	}
	return time.Unix(int64(s), 0).UTC(), nil
}

// Apply writes the Windows and NIC settings that read positively wrong, in the
// order Fast Startup, magic packet, EEE, Realtek shutdown wake, each within
// the limiter, then re-reads every one. It never restarts an adapter, never
// reboots, never writes a value it could not read, and never reverts.
func Apply(ctx context.Context, in ApplyInputs) ApplyReport {
	st := in.State
	if st == nil {
		st = &ApplyState{}
	}
	now := in.Now.UTC()
	rep := ApplyReport{Readings: in.Readings, Failed: map[string]string{}}
	st.Limiter.Observe(in.PolicyFingerprint)
	pruneForAdapters(st, in.Readings, in.Memory)
	clearPending(st, in.Readings, in.Memory, in.BootTime)

	var attempted []Op
	if in.Configure && in.Writer != nil {
		for _, op := range planOps(in.Virtual, in.Readings, in.Memory, now) {
			if ctx.Err() != nil {
				break
			}
			key := op.Key()
			if !st.Limiter.Allow(key, now) {
				continue
			}
			prev, had := st.Limiter.Entries[key]
			st.Limiter.begin(key, now)
			if err := persist(in, *st); err != nil {
				// Fail closed: an attempt that cannot be recorded is not made.
				if had {
					st.Limiter.Entries[key] = prev
				} else {
					delete(st.Limiter.Entries, key)
				}
				log.Warn("wake settings not applied: attempt could not be persisted", "error", err.Error())
				break
			}
			attempted = append(attempted, op)
			rep.Attempted = append(rep.Attempted, key)
			if err := in.Writer.Write(ctx, op); err != nil {
				rep.Failed[key] = "write_error"
				log.Warn("wake setting write failed", "setting", key, "error", err.Error())
			}
		}
	}

	if len(attempted) > 0 {
		var after *WindowsReadings
		var err error
		if in.Reread != nil {
			after, err = in.Reread(ctx)
		} else {
			err = fmt.Errorf("no re-read")
		}
		if err != nil || after == nil {
			for _, op := range attempted {
				if _, failed := rep.Failed[op.Key()]; !failed {
					rep.Failed[op.Key()] = "readback_unavailable"
				}
			}
			if err != nil {
				log.Warn("wake settings could not be read back", "error", err.Error())
			}
		} else {
			rep.Readings = after
			for _, op := range attempted {
				key := op.Key()
				if _, failed := rep.Failed[key]; failed {
					continue
				}
				if !satisfied(op, after) {
					rep.Failed[key] = "readback_mismatch"
					continue
				}
				st.Limiter.succeeded(key)
				if op.Kind.needsReboot() {
					if st.Pending == nil {
						st.Pending = map[string]time.Time{}
					}
					st.Pending[key] = now
				}
			}
		}
		st.LastApplyAt = now
		switch n := len(rep.Failed); {
		case n == 0:
			st.LastApplyResult = "ok"
		case n == len(attempted):
			st.LastApplyResult = "failed"
		default:
			st.LastApplyResult = "partial"
		}
	}
	if err := persist(in, *st); err != nil && len(attempted) > 0 {
		log.Warn("wake apply results not persisted", "error", err.Error())
	}
	rep.Status = statusFor(st, rep.Readings, in.Virtual, in.Memory, in.Configure, now)
	return rep
}

func persist(in ApplyInputs, st ApplyState) error {
	if in.Persist == nil {
		return fmt.Errorf("no persistence")
	}
	return in.Persist(st)
}

// planOps lists the settings that read positively wrong, in apply order. It
// shares Compute's preconditions: no writes on a VM, when the NetAdapter
// cmdlets are missing, or with no wired adapter present or remembered. NIC
// writes go only to adapters present now. unknown, unsupported and absent
// values are never written.
func planOps(virtual bool, r *WindowsReadings, mem AdapterMemory, now time.Time) []Op {
	if virtual || r == nil || r.NetAdapterCmdletsUnavailable {
		return nil
	}
	if len(r.Adapters) == 0 && !rememberedAdapter(mem, now) {
		return nil
	}
	var ops []Op
	if r.FastStartup == "enabled" {
		ops = append(ops, Op{Kind: OpFastStartupOff})
	}
	adapters := append([]AdapterReading(nil), r.Adapters...)
	sort.Slice(adapters, func(i, j int) bool { return adapters[i].MAC < adapters[j].MAC })
	for _, kind := range []OpKind{OpMagicPacketOn, OpEEEOff, OpShutdownWakeOn} {
		for _, a := range adapters {
			if wrongFor(kind, a) {
				ops = append(ops, Op{Kind: kind, MAC: strings.ToLower(a.MAC)})
			}
		}
	}
	return ops
}

func rememberedAdapter(mem AdapterMemory, now time.Time) bool {
	for _, rec := range mem {
		if now.Sub(rec.LastSeenAt) <= adapterMemoryTTL {
			return true
		}
	}
	return false
}

func wrongFor(kind OpKind, a AdapterReading) bool {
	switch kind {
	case OpMagicPacketOn:
		return a.MagicPacket == "disabled"
	case OpEEEOff:
		return a.EEE == "enabled"
	case OpShutdownWakeOn:
		return a.ShutdownWake == "disabled"
	}
	return false
}

func findAdapter(r *WindowsReadings, mac string) (AdapterReading, bool) {
	for _, a := range r.Adapters {
		if strings.EqualFold(a.MAC, mac) {
			return a, true
		}
	}
	return AdapterReading{}, false
}

// satisfied reports whether the re-read shows the target value.
func satisfied(op Op, r *WindowsReadings) bool {
	if op.Kind == OpFastStartupOff {
		return r.FastStartup == "disabled"
	}
	a, ok := findAdapter(r, op.MAC)
	if !ok {
		return false
	}
	switch op.Kind {
	case OpMagicPacketOn:
		return a.MagicPacket == "enabled"
	case OpEEEOff:
		return a.EEE == "disabled"
	case OpShutdownWakeOn:
		return a.ShutdownWake == "enabled"
	}
	return false
}

// keyMAC returns the MAC of a NIC key, or "" for a machine-wide key.
func keyMAC(key string) string {
	rest, ok := strings.CutPrefix(key, "nic:")
	if !ok {
		return ""
	}
	if i := strings.LastIndex(rest, ":"); i > 0 {
		return rest[:i]
	}
	return ""
}

// pruneForAdapters drops limiter and pending entries for adapters that are
// neither present nor remembered, so the state stays bounded. A remembered
// (undocked) adapter keeps its history, so docking does not reset a block.
func pruneForAdapters(st *ApplyState, r *WindowsReadings, mem AdapterMemory) {
	if r == nil {
		return
	}
	known := map[string]bool{}
	for _, a := range r.Adapters {
		known[strings.ToLower(a.MAC)] = true
	}
	for mac := range mem {
		known[strings.ToLower(mac)] = true
	}
	for key := range st.Limiter.Entries {
		if mac := keyMAC(key); mac != "" && !known[mac] {
			delete(st.Limiter.Entries, key)
		}
	}
	for key := range st.Pending {
		if mac := keyMAC(key); mac != "" && !known[mac] {
			delete(st.Pending, key)
		}
	}
}

// clearPending drops a pending write once the machine has booted after it, or
// when its value drifted (the limiter then governs a re-apply). An unreadable
// boot time keeps every pending write.
func clearPending(st *ApplyState, r *WindowsReadings, mem AdapterMemory, bootTime func() (time.Time, error)) {
	if len(st.Pending) == 0 {
		return
	}
	var boot time.Time
	if bootTime != nil {
		if b, err := bootTime(); err == nil {
			boot = b
		}
	}
	for key, at := range st.Pending {
		if !boot.IsZero() && boot.After(at) {
			delete(st.Pending, key)
			continue
		}
		if r == nil {
			continue
		}
		if mac := keyMAC(key); mac != "" {
			if a, ok := findAdapter(r, mac); ok {
				for _, kind := range []OpKind{OpMagicPacketOn, OpEEEOff, OpShutdownWakeOn} {
					if (Op{Kind: kind, MAC: mac}).Key() == key && wrongFor(kind, a) {
						delete(st.Pending, key)
					}
				}
			}
		}
	}
}

// statusFor derives the reportable apply status. Failures, blocks and
// deferrals only count while configure is on: with it off a wrong setting is
// simply not_configured.
func statusFor(st *ApplyState, r *WindowsReadings, virtual bool, mem AdapterMemory, configure bool, now time.Time) ApplyStatus {
	s := ApplyStatus{Configure: configure, LastApplyAt: st.LastApplyAt, LastApplyResult: st.LastApplyResult}
	for key := range st.Pending {
		s.Pending = append(s.Pending, key)
	}
	if configure {
		for _, op := range planOps(virtual, r, mem, now) {
			key := op.Key()
			switch {
			case st.Limiter.Blocked(key):
				s.Blocked = append(s.Blocked, key)
				s.Failed = append(s.Failed, key)
			case st.Limiter.failures(key) > 0:
				s.Failed = append(s.Failed, key)
			case !st.Limiter.Allow(key, now):
				s.Deferred = append(s.Deferred, key)
			}
		}
	}
	sort.Strings(s.Pending)
	sort.Strings(s.Failed)
	sort.Strings(s.Blocked)
	sort.Strings(s.Deferred)
	return s
}
