//go:build linux

package isolation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/cgroup"
	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// TODO(#10098-activation): flip to true only in the activation PR, after L2 passes. Todd gate.
const linuxIsolationActivated = false

// Readiness reasons reported in securityCapabilities.networkIsolationUnsupportedReason.
// The cgroup reasons come from the cgroup package.
const (
	linuxReasonNotActivated    = "not_activated"
	linuxReasonNftMissing      = "nft_missing"
	linuxReasonNoCgroupv2Match = "nft_cgroupv2_unsupported"
	linuxReasonCancelled       = "readiness_cancelled"
	linuxReasonRecovery        = "recovery_unavailable"
	linuxReasonScheduler       = "scheduler_unavailable"
)

// linuxToolTimeout bounds one nft or conntrack run; a wedged netlink socket
// must not hold the machine lock indefinitely.
const linuxToolTimeout = 30 * time.Second

// linuxToolDirs are searched after PATH: the recovery binary runs from a bare
// systemd environment, and a distro may keep nft in sbin only.
var linuxToolDirs = []string{"/usr/sbin", "/sbin", "/usr/bin", "/bin"}

// nftCgroupPathPattern is what may go into an nft script as a cgroup path.
// Anything else is refused rather than quoted, including the backslash of a
// systemd-escaped unit name: how nft reads an escape is not ours to guess.
var nftCgroupPathPattern = regexp.MustCompile(`^[A-Za-z0-9_.@:/-]+$`)

// linuxIsolator is the nftables mechanism: one table, `inet breeze_isolation`,
// that it creates, reads and deletes, and never anyone else's.
type linuxIsolator struct {
	// activated is linuxIsolationActivated; a field only so tests can force the
	// activated wiring. Production never changes it.
	activated bool
	readiness readinessCache

	nft        func(ctx context.Context, stdin []byte, args ...string) ([]byte, error)
	conntrack  func(ctx context.Context, args ...string) ([]byte, error)
	lookPath   func(string) (string, error)
	layout     func() (cgroup.Layout, error)
	baseline   func() (Baseline, error)
	executable func() (string, error)

	// setupCgroup splits the agent's cgroup with child placement on.
	setupCgroup func() (cgroup.Layout, error)

	mu    sync.Mutex
	notes []string

	splitMu sync.Mutex
	split   *cgroup.Layout
}

// NewPlatformIsolator provides real nftables release and inspection even while
// capability stays zero: a build must always be able to remove inherited rules.
func NewPlatformIsolator() Isolator { return newLinuxIsolator() }

func newLinuxIsolator() *linuxIsolator {
	i := &linuxIsolator{
		activated:   linuxIsolationActivated,
		lookPath:    lookPathLinuxTool,
		baseline:    readLinuxBaseline,
		executable:  os.Executable,
		setupCgroup: setupAgentCgroup,
	}
	i.layout = i.splitLayout
	i.nft = func(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
		return i.runTool(ctx, "nft", stdin, args...)
	}
	i.conntrack = func(ctx context.Context, args ...string) ([]byte, error) {
		return i.runTool(ctx, "conntrack", nil, args...)
	}
	return i
}

// setupAgentCgroup turns child placement on before the agent moves, so no child
// can ever start in the permitted cgroup.
func setupAgentCgroup() (cgroup.Layout, error) {
	return cgroup.SetupSelf(
		func(l cgroup.Layout) error { return procspawn.Enable(l.ChildrenFD, l.ChildrenPath) },
		func() { procspawn.SetChildrenCgroup(-1) },
	)
}

func lookPathLinuxTool(name string) (string, error) {
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	for _, dir := range linuxToolDirs {
		path := dir + "/" + name
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return path, nil
		}
	}
	return "", fmt.Errorf("%s: %w", name, exec.ErrNotFound)
}

func (i *linuxIsolator) runTool(ctx context.Context, name string, stdin []byte, args ...string) ([]byte, error) {
	path, err := i.lookPath(name)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, linuxToolTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, path, args...)
	// Errors are logged and journalled; keep them readable on any locale.
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// requireNft distinguishes "this host has no nft" from an nft failure: without
// the tool nothing can be observed, and only an unsupported engine may let an
// uninstall proceed on an idle journal (see Manager.ReleaseAll).
func (i *linuxIsolator) requireNft() error {
	if _, err := i.lookPath("nft"); err != nil {
		return fmt.Errorf("%w: nft is not installed: %v", ErrUnsupported, err)
	}
	return nil
}

// Capability reads only cached readiness; a heartbeat never runs nft, touches
// a cgroup or asks systemd. No readiness result can pass the activation switch.
func (i *linuxIsolator) Capability() Capability {
	c := Capability{Mechanism: "nft"}
	if !i.activated {
		c.UnsupportedReason = linuxReasonNotActivated
		return c
	}
	r := &i.readiness
	r.mu.Lock()
	defer r.mu.Unlock()
	elapsed := r.clock().Sub(r.checkedAt)
	var engine *linuxEngineError
	switch {
	case r.checkedAt.IsZero() || elapsed < 0 || elapsed >= readinessMaxAge:
		c.UnsupportedReason = linuxReasonRecovery // no fresh proof of anything
	case r.in.engineErr != nil:
		c.UnsupportedReason = cgroup.ReasonUnavailable
		if errors.As(r.in.engineErr, &engine) {
			c.UnsupportedReason = engine.reason
		}
	case r.in.recoveryErr != nil:
		c.UnsupportedReason = linuxReasonRecovery
	case !r.in.schedulerReady:
		c.UnsupportedReason = linuxReasonScheduler
	default:
		c.Version = 1
		c.Ready = true
	}
	return c
}

// linuxEngineError carries which of the mechanism's own prerequisites failed
// through the shared readiness cache.
type linuxEngineError struct {
	reason string
	err    error
}

func (e *linuxEngineError) Error() string { return e.reason + ": " + e.err.Error() }
func (e *linuxEngineError) Unwrap() error { return e.err }

func (i *linuxIsolator) configureRecoveryReadiness(scheduler RecoveryScheduler, wantVersion string) {
	i.configureReadiness(func(ctx context.Context) (string, error) { return recoveryinstall.EnsureRecovery(ctx, wantVersion) }, scheduler.Ready)
}

func (i *linuxIsolator) configureReadiness(ensure func(context.Context) (string, error), scheduler func() (bool, string)) {
	i.readiness.mu.Lock()
	defer i.readiness.mu.Unlock()
	i.readiness.probe = func(ctx context.Context) readinessInputs {
		if err := ctx.Err(); err != nil {
			return readinessInputs{engineErr: &linuxEngineError{linuxReasonCancelled, err}, recoveryErr: err, schedulerReason: "cancelled"}
		}
		engineErr := i.probeEngine(ctx)
		_, recoveryErr := ensure(ctx)
		ready, reason := scheduler()
		return readinessInputs{engineErr: engineErr, recoveryErr: recoveryErr, schedulerReady: ready, schedulerReason: reason}
	}
	i.readiness.checkedAt = time.Time{}
}

// probeEngine checks nft, establishes the cgroup split, and dry-runs the
// process-scoped permit. The split happens here, so only an activated agent
// ever moves itself or places a child.
func (i *linuxIsolator) probeEngine(ctx context.Context) error {
	if _, err := i.lookPath("nft"); err != nil {
		return &linuxEngineError{linuxReasonNftMissing, err}
	}
	if err := i.ensureSplit(); err != nil {
		return err
	}
	layout, err := i.splitLayout()
	if err != nil {
		return &linuxEngineError{cgroup.ReasonUnavailable, err}
	}
	if !nftCgroupPathPattern.MatchString(layout.AgentPath) || layout.Level < 1 {
		return &linuxEngineError{cgroup.ReasonUnavailable, fmt.Errorf("cgroup path %q cannot go in an nft rule", layout.AgentPath)}
	}
	// `socket cgroupv2` needs Linux 5.13, later than the cgroup split and
	// clone3 placement (5.7). The kernel answers a dry run (-c commits
	// nothing), so a 5.7-5.12 host reports this instead of advertising Ready
	// and failing every apply.
	if _, err := i.nft(ctx, []byte(nftCgroupv2Probe(layout)), "-c", "-f", "-"); err != nil {
		return &linuxEngineError{linuxReasonNoCgroupv2Match, err}
	}
	return nil
}

// nftCgroupv2Probe is never committed: it only asks the kernel whether it can
// match a socket on the agent's cgroup. Its own table name and an accept policy
// keep it harmless even if a caller dropped -c.
func nftCgroupv2Probe(layout cgroup.Layout) string {
	return fmt.Sprintf("table %s %s_probe {\n\tchain output {\n\t\ttype filter hook output priority filter - 10; policy accept;\n\t\tsocket cgroupv2 level %d %q accept\n\t}\n}\n",
		nftFamily, nftTable, layout.Level, layout.AgentPath)
}

func (i *linuxIsolator) ensureSplit() error {
	i.splitMu.Lock()
	defer i.splitMu.Unlock()
	if i.split != nil {
		return nil
	}
	layout, err := i.setupCgroup()
	if err != nil {
		reason := cgroup.ReasonUnavailable
		var refusal *cgroup.Error
		if errors.As(err, &refusal) {
			reason = refusal.Reason
		}
		return &linuxEngineError{reason, err}
	}
	i.split = &layout
	return nil
}

// splitLayout is what Apply permits. Before a successful split there is no
// cgroup to scope a permit to, so there is nothing to apply.
func (i *linuxIsolator) splitLayout() (cgroup.Layout, error) {
	i.splitMu.Lock()
	defer i.splitMu.Unlock()
	if i.split == nil {
		return cgroup.Layout{}, errors.New("the agent's cgroup has not been split")
	}
	return *i.split, nil
}

// While not activated, readiness is never probed: the result would be masked by
// not_activated anyway, and a shipped capability-0 agent must not move itself
// between cgroups, enable child placement, or ask systemd anything on a timer.
func (i *linuxIsolator) RefreshReadiness(ctx context.Context) {
	if i.activated {
		i.readiness.refresh(ctx, true)
	}
}

func (i *linuxIsolator) refreshCachedReadiness(ctx context.Context) {
	if i.activated {
		i.readiness.refresh(ctx, false)
	}
}

// BinaryPaths reports the running agent for the upgrade handoff. The nft permit
// is scoped by cgroup, so a swap at the same path needs no rule change.
func (i *linuxIsolator) BinaryPaths() []string {
	path, err := i.executable()
	if err != nil {
		log.Warn("cannot resolve the agent executable", "error", err)
		return nil
	}
	return []string{path}
}

// Apply replaces the table in one nft transaction after a dry run, flushes the
// flows no permit marked, and digests what the kernel actually installed.
func (i *linuxIsolator) Apply(ctx context.Context, spec ResolvedSpec) (Digest, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := i.requireNft(); err != nil {
		return "", err
	}
	layout, err := i.layout()
	if err != nil {
		return "", err
	}
	if !nftCgroupPathPattern.MatchString(layout.AgentPath) || layout.Level < 1 {
		return "", fmt.Errorf("refusing unusable cgroup path %q at level %d", layout.AgentPath, layout.Level)
	}
	baseline, err := i.baseline()
	if err != nil {
		return "", fmt.Errorf("read Linux isolation baseline: %w", err)
	}
	if err := i.load(ctx, buildNftRuleset(spec, layout, baseline)); err != nil {
		return "", err
	}
	i.flushFlows(ctx)
	data, err := i.listTable(ctx)
	if err != nil {
		return "", fmt.Errorf("read back nft isolation: %w", err)
	}
	return digestNftListing(data)
}

// applyBootRules installs the pre-network rules from the recovery binary. The
// agent's cgroup does not exist yet, so the layout is deliberately not read.
func (i *linuxIsolator) applyBootRules(ctx context.Context, spec ResolvedSpec) error {
	if err := i.requireNft(); err != nil {
		return err
	}
	baseline, err := i.baseline()
	if err != nil {
		return fmt.Errorf("read Linux isolation baseline: %w", err)
	}
	return i.load(ctx, buildNftBootRuleset(spec, baseline))
}

func (i *linuxIsolator) load(ctx context.Context, ruleset string) error {
	batch := []byte(nftBatch(ruleset))
	// The dry run asks the kernel too, so a kernel without `socket cgroupv2`
	// (added in 5.13) refuses here with the host untouched.
	if _, err := i.nft(ctx, batch, "-c", "-f", "-"); err != nil {
		return fmt.Errorf("nft refused the isolation rules: %w", err)
	}
	if _, err := i.nft(ctx, batch, "-f", "-"); err != nil {
		return fmt.Errorf("load nft isolation rules: %w", err)
	}
	return nil
}

// flushFlows tears down every existing flow so an open connection cannot
// outlive the apply; it also clears conntrack-offloaded flows a forward chain
// never sees. All of them, not just unmarked ones: the mark outlives its
// permit, so a flow marked under an earlier generation's or episode's allowlist
// would otherwise keep matching the established rule. Flows that still qualify
// re-mark themselves on their next outbound packet through the permit, which
// has no `ct state new` clause.
//
// The rules are already enforcing, so a failure is reported but is not an
// apply failure: the drop rules still stop unmarked flows' packets.
func (i *linuxIsolator) flushFlows(ctx context.Context) {
	if _, err := i.lookPath("conntrack"); err != nil {
		log.Warn("conntrack is not installed; existing flows are dropped by the rules but not flushed")
		i.note("conntrack_unavailable")
		return
	}
	if _, err := i.conntrack(ctx, "-F"); err != nil {
		log.Warn("conntrack flush failed", "error", err)
		i.note("conntrack_flush_failed")
	}
}

func (i *linuxIsolator) note(event string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.notes = append(i.notes, event)
}

// TakeApplyNotes hands the manager what to journal about the last Apply.
func (i *linuxIsolator) TakeApplyNotes() []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	notes := i.notes
	i.notes = nil
	return notes
}

func (i *linuxIsolator) listTable(ctx context.Context) ([]byte, error) {
	return i.nft(ctx, nil, "-j", "list", "table", nftFamily, nftTable)
}

// Verify digests the installed table. A missing table is an error, which the
// manager treats as drift and re-applies.
func (i *linuxIsolator) Verify(ctx context.Context, _ ResolvedSpec) (Digest, error) {
	if err := i.requireNft(); err != nil {
		return "", err
	}
	data, err := i.listTable(ctx)
	if err != nil {
		return "", err
	}
	return digestNftListing(data)
}

// Release deletes our table and confirms it is gone.
func (i *linuxIsolator) Release(ctx context.Context) error {
	owned, err := i.Owned(ctx)
	if err != nil {
		return err
	}
	if owned {
		if _, err := i.nft(ctx, nil, "delete", "table", nftFamily, nftTable); err != nil {
			return fmt.Errorf("release nft isolation: %w", err)
		}
		if owned, err = i.Owned(ctx); err != nil {
			return fmt.Errorf("confirm nft isolation release: %w", err)
		}
		if owned {
			return errors.New("release left the nft isolation table installed")
		}
	}
	return nil
}

// Owned lists tables rather than listing ours, so "absent" never depends on
// matching a localized error string.
func (i *linuxIsolator) Owned(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if err := i.requireNft(); err != nil {
		return false, err
	}
	data, err := i.nft(ctx, nil, "-j", "list", "tables")
	if err != nil {
		return false, fmt.Errorf("list nft tables: %w", err)
	}
	items, err := parseNftListing(data)
	if err != nil {
		return false, err
	}
	for _, item := range items {
		table, ok := item["table"].(map[string]any)
		if ok && table["family"] == nftFamily && table["name"] == nftTable {
			return true, nil
		}
	}
	return false, nil
}

// Mark snapshots the drop counter before a negative probe.
func (i *linuxIsolator) Mark(ctx context.Context) (Marker, error) {
	packets, err := i.dropCount(ctx)
	if err != nil {
		return Marker{}, err
	}
	return Marker{Value: packets, At: time.Now()}, nil
}

// DropObserved reports whether our final drop rule fired since the marker.
func (i *linuxIsolator) DropObserved(ctx context.Context, since Marker) (bool, error) {
	packets, err := i.dropCount(ctx)
	if err != nil {
		return false, err
	}
	return packets > since.Value, nil
}

func (i *linuxIsolator) dropCount(ctx context.Context) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := i.requireNft(); err != nil {
		return 0, err
	}
	data, err := i.nft(ctx, nil, "-j", "list", "counter", nftFamily, nftTable, nftCounter)
	if err != nil {
		return 0, fmt.Errorf("read the nft drop counter: %w", err)
	}
	items, err := parseNftListing(data)
	if err != nil {
		return 0, err
	}
	for _, item := range items {
		counter, ok := item["counter"].(map[string]any)
		if !ok || counter["name"] != nftCounter {
			continue
		}
		number, ok := counter["packets"].(json.Number)
		if !ok {
			return 0, errors.New("the nft drop counter has no packet count")
		}
		packets, err := strconv.ParseUint(number.String(), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parse the nft drop counter: %w", err)
		}
		return packets, nil
	}
	return 0, errors.New("the nft drop counter is not installed")
}

func sortedNftElements(elements []any) []any {
	type keyed struct {
		key  string
		item any
	}
	list := make([]keyed, len(elements))
	for n, item := range elements {
		b, _ := json.Marshal(item)
		list[n] = keyed{string(b), item}
	}
	sort.Slice(list, func(a, b int) bool { return list[a].key < list[b].key })
	out := make([]any, len(list))
	for n, k := range list {
		out[n] = k.item
	}
	return out
}

func parseNftListing(data []byte) ([]map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var listing struct {
		Nftables []map[string]any `json:"nftables"`
	}
	if err := decoder.Decode(&listing); err != nil {
		return nil, fmt.Errorf("parse nft listing: %w", err)
	}
	return listing.Nftables, nil
}

// digestNftListing hashes the rule set the kernel reports, minus what changes
// without the rules changing: rule handles (renumbered on every load) and
// packet and byte counts. It also refuses a table that would not actually
// isolate, so a readback mismatch fails the apply rather than passing a probe.
func digestNftListing(data []byte) (Digest, error) {
	items, err := parseNftListing(data)
	if err != nil {
		return "", err
	}
	kept := make([]any, 0, len(items))
	chains := map[string]bool{}
	for _, item := range items {
		if _, meta := item["metainfo"]; meta {
			continue
		}
		if chain, ok := item["chain"].(map[string]any); ok {
			name, _ := chain["name"].(string)
			if chain["hook"] == name && (name == "input" || name == "output" || name == "forward") {
				if chain["policy"] != "drop" {
					return "", fmt.Errorf("nft isolation chain %s has policy %v", name, chain["policy"])
				}
				chains[name] = true
			}
		}
		kept = append(kept, stripNftVolatile(item))
	}
	for _, name := range []string{"input", "output", "forward"} {
		if !chains[name] {
			return "", fmt.Errorf("nft isolation has no %s base chain", name)
		}
	}
	canonical, err := json.Marshal(kept)
	if err != nil {
		return "", fmt.Errorf("canonicalize nft listing: %w", err)
	}
	sum := sha256.Sum256(canonical)
	return Digest(hex.EncodeToString(sum[:])), nil
}

func stripNftVolatile(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			switch key {
			case "handle", "packets", "bytes":
				continue
			}
			item = stripNftVolatile(item)
			// An anonymous set is unordered; nft may list its elements in a
			// different order after a reload, which is not drift.
			if elements, ok := item.([]any); ok && key == "set" {
				item = sortedNftElements(elements)
			}
			out[key] = item
		}
		return out
	case []any:
		out := make([]any, len(v))
		for n, item := range v {
			out[n] = stripNftVolatile(item)
		}
		return out
	default:
		return value
	}
}
