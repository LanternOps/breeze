//go:build darwin

package isolation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/atomicrename"
)

// pfTokenFile holds the token of our pf enable reference, beside the journal.
const pfTokenFile = "isolation-pf-token"

// darwinIsolator is the pf mechanism (spec §3.5, OD13 a′). Rules only ever go in
// our own anchor; the main ruleset is loaded at most once, by AttachOnce; and pf
// is never turned off, only our own enable reference is released.
//
// Calls that change anything arrive under the manager's machine lock.
type darwinIsolator struct {
	runner   func(context.Context) PFRunner
	baseline func(context.Context) (pfBaseline, error)
	tokens   pfTokenStore
}

func newDarwinIsolator(dataDir string) *darwinIsolator {
	return &darwinIsolator{
		runner:   func(ctx context.Context) PFRunner { return execPFRunner{ctx: ctx} },
		baseline: readDarwinBaseline,
		tokens:   pfTokenStore{path: filepath.Join(dataDir, pfTokenFile)},
	}
}

// readDarwinBaseline asks the system resolver what it is configured to use. A
// read failure stops Apply before anything changes.
func readDarwinBaseline(ctx context.Context) (pfBaseline, error) {
	stdout, _, err := execPFRunner{ctx: ctx}.run("", "/usr/sbin/scutil", "--dns")
	if err != nil {
		return pfBaseline{}, fmt.Errorf("read the DNS configuration: %w", err)
	}
	return parseScutilDNS(stdout), nil
}

// Capability reports what this build can do. Task 4 fills in readiness.
func (i *darwinIsolator) Capability() Capability {
	return Capability{Mechanism: "pf", UnsupportedReason: "not_activated"}
}

// Apply installs the rule set: refuse or attach, load the anchor atomically
// (both address families or neither), hold a pf enable reference, then cut every
// existing flow no permit matches. Enforcement starts at the enable, so a
// failure past that point must surface: the manager's rollback removes the rules.
func (i *darwinIsolator) Apply(ctx context.Context, spec ResolvedSpec) (Digest, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	baseline, err := i.baseline(ctx)
	if err != nil {
		return "", err
	}
	r := i.runner(ctx)
	if err := AttachOnce(r); err != nil {
		return "", err
	}
	if _, _, err := r.Pfctl(buildDarwinRules(spec, baseline), "-a", pfAnchorPath, "-f", "-"); err != nil {
		return "", fmt.Errorf("load the isolation anchor: %w", err)
	}
	rules, err := readPFAnchor(r)
	if err != nil {
		return "", fmt.Errorf("read the isolation anchor back: %w", err)
	}
	if err := checkPFDropRule(rules); err != nil {
		return "", err
	}
	if err := i.holdEnableReference(r); err != nil {
		return "", err
	}
	if err := killUnpermittedStates(r, spec, baseline); err != nil {
		return "", err
	}
	return pfRulesDigest(rules), nil
}

// holdEnableReference takes our pf reference unless we still hold one. A refresh
// must not pile references up. A journalled token the kernel no longer lists
// (the Mac rebooted, or an admin turned pf off) is stale, so a new one replaces it.
func (i *darwinIsolator) holdEnableReference(r PFRunner) error {
	token, err := i.tokens.load()
	if err != nil {
		return fmt.Errorf("read the pf reference token: %w", err)
	}
	if token != "" {
		held, err := pfReferenceHeld(r, token)
		if err != nil {
			return err
		}
		if held {
			return nil
		}
	}
	stdout, stderr, err := r.Pfctl("", "-E")
	if err != nil {
		return fmt.Errorf("enable pf: %w", err)
	}
	m := pfTokenLine.FindStringSubmatch(stdout + "\n" + stderr)
	if m == nil {
		return errors.New("pfctl -E did not report a reference token")
	}
	if err := i.tokens.save(m[1]); err != nil {
		return fmt.Errorf("journal the pf reference token: %w", err)
	}
	return nil
}

var (
	pfTokenLine     = regexp.MustCompile(`(?m)^\s*Token\s*:\s*(\d+)\s*$`)
	pfStatusEnabled = regexp.MustCompile(`(?m)^\s*Status:\s*Enabled\b`)
)

func pfReferenceHeld(r PFRunner, token string) (bool, error) {
	stdout, _, err := r.Pfctl("", "-s", "References")
	if err != nil {
		return false, fmt.Errorf("list the pf references: %w", err)
	}
	return slices.Contains(strings.Fields(stdout), token), nil
}

func killUnpermittedStates(r PFRunner, spec ResolvedSpec, baseline pfBaseline) error {
	stdout, _, err := r.Pfctl("", "-ss")
	if err != nil {
		return fmt.Errorf("list the pf states: %w", err)
	}
	kills, err := statesToKill(stdout, spec, baseline)
	if err != nil {
		return err
	}
	for _, kill := range kills {
		if _, _, err := r.Pfctl("", "-k", kill.Origin, "-k", kill.Peer); err != nil {
			return fmt.Errorf("cut existing flows: %w", err)
		}
	}
	return nil
}

func readPFAnchor(r PFRunner) (string, error) {
	stdout, _, err := r.Pfctl("", "-a", pfAnchorPath, "-sr")
	return stdout, err
}

// checkPFDropRule: rules that end in anything but our drop allow everything else.
func checkPFDropRule(rules string) error {
	lines := pfLogicalLines(rules)
	if len(lines) > 0 {
		last := lines[len(lines)-1]
		if strings.HasPrefix(last, "block drop") && strings.Contains(last, "quick") && strings.Contains(last, `label "`+pfDropLabel+`"`) {
			return nil
		}
	}
	return fmt.Errorf("the isolation anchor does not end in the %s drop rule", pfDropLabel)
}

// pfRulesDigest hashes what pf reports, not what we asked for, so that anything
// else changing the anchor changes the digest. Statistics are not in `-sr`.
func pfRulesDigest(rules string) Digest {
	sum := sha256.Sum256([]byte(strings.Join(pfLogicalLines(rules), "\n")))
	return Digest(hex.EncodeToString(sum[:]))
}

// Verify reads the engine back and changes nothing. A detached parent hook or pf
// turned off is an error, which sends the manager down its drift path: a refresh
// re-attaches through AttachOnce (so only onto a compatible ruleset), re-runs the
// probes, and journals drift_reapplied. If the ruleset has become incompatible
// the refresh fails, and its reason reaches the server as LastError.
func (i *darwinIsolator) Verify(ctx context.Context, _ ResolvedSpec) (Digest, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	r := i.runner(ctx)
	rules, err := readPFAnchor(r)
	if err != nil {
		return "", fmt.Errorf("read the isolation anchor: %w", err)
	}
	if err := checkPFDropRule(rules); err != nil {
		return "", err
	}
	present, err := ParentHookPresent(r)
	if err != nil {
		return "", err
	}
	if !present {
		log.Warn("the pf main ruleset no longer references the isolation anchor; isolation is not being enforced")
		return "", errors.New("the pf parent hook is missing: the main ruleset was reloaded")
	}
	enabled, err := pfEnabled(r)
	if err != nil {
		return "", err
	}
	if !enabled {
		log.Warn("pf is not enabled; isolation is not being enforced")
		return "", errors.New("pf is not enabled")
	}
	return pfRulesDigest(rules), nil
}

func pfEnabled(r PFRunner) (bool, error) {
	stdout, _, err := r.Pfctl("", "-si")
	if err != nil {
		return false, fmt.Errorf("read the pf status: %w", err)
	}
	return pfStatusEnabled.MatchString(stdout), nil
}

// enforcing reports whether the installed rules can currently act: anchor
// populated, parent hook attached, pf on. Boot recovery re-installs when they
// cannot, because pf keeps none of this across a reboot.
func (i *darwinIsolator) enforcing(ctx context.Context) (bool, error) {
	owned, err := i.Owned(ctx)
	if err != nil || !owned {
		return false, err
	}
	r := i.runner(ctx)
	present, err := ParentHookPresent(r)
	if err != nil || !present {
		return false, err
	}
	return pfEnabled(r)
}

// Release flushes our anchor, then gives back our own pf reference. The parent
// hook stays: an empty anchor is harmless, and removing it would take the very
// main-ruleset load this design exists to avoid. Success means absence observed.
func (i *darwinIsolator) Release(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r := i.runner(ctx)
	owned, err := i.Owned(ctx)
	if err != nil {
		return fmt.Errorf("inspect the isolation anchor: %w", err)
	}
	if owned {
		if _, _, err := r.Pfctl("", "-a", pfAnchorPath, "-F", "all"); err != nil {
			return fmt.Errorf("flush the isolation anchor: %w", err)
		}
	}
	if err := i.releaseEnableReference(r); err != nil {
		return err
	}
	owned, err = i.Owned(ctx)
	if err != nil {
		return fmt.Errorf("confirm the isolation anchor is empty: %w", err)
	}
	if owned {
		return errors.New("the isolation anchor still holds rules after the flush")
	}
	return nil
}

// releaseEnableReference gives back only the reference we took. A token the
// kernel no longer holds is forgotten; one it still holds is a failure, retried
// while recovery stays armed. With no token there is nothing we may release:
// a reference leaked by a crash leaves pf on with an empty anchor, which is safe.
func (i *darwinIsolator) releaseEnableReference(r PFRunner) error {
	token, err := i.tokens.load()
	if err != nil {
		log.Warn("the pf reference token is unreadable; leaving pf enabled", "error", err.Error())
		return i.tokens.clear()
	}
	if token == "" {
		return nil
	}
	if _, _, releaseErr := r.Pfctl("", "-X", token); releaseErr != nil {
		held, err := pfReferenceHeld(r, token)
		if err != nil {
			return errors.Join(releaseErr, err)
		}
		if held {
			return fmt.Errorf("release the pf reference: %w", releaseErr)
		}
	}
	return i.tokens.clear()
}

// Owned reports whether our anchor holds any rule. Reading a ruleset that does
// not exist is an error from pfctl, and that is the normal state of a Mac that
// was never isolated, so a failed read counts as absence only when pf itself
// answers and does not list our top-level anchor. Anything else is an error:
// an engine we cannot see never confirms absence.
func (i *darwinIsolator) Owned(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	r := i.runner(ctx)
	rules, readErr := readPFAnchor(r)
	if readErr == nil {
		return len(pfLogicalLines(rules)) > 0, nil
	}
	stdout, _, err := r.Pfctl("", "-sA")
	if err != nil {
		return false, errors.Join(readErr, err)
	}
	if slices.Contains(parsePFAnchorList(stdout), strings.SplitN(pfAnchorPath, "/", 2)[0]) {
		return false, fmt.Errorf("read the isolation anchor: %w", readErr)
	}
	return false, nil
}

// Mark snapshots the drop rule's packet counter before the negative probe.
func (i *darwinIsolator) Mark(ctx context.Context) (Marker, error) {
	packets, err := i.dropPackets(ctx)
	if err != nil {
		return Marker{}, err
	}
	return Marker{Value: packets, At: time.Now()}, nil
}

// DropObserved reports whether our drop rule's counter moved since the mark.
func (i *darwinIsolator) DropObserved(ctx context.Context, since Marker) (bool, error) {
	packets, err := i.dropPackets(ctx)
	if err != nil {
		return false, err
	}
	return packets > since.Value, nil
}

func (i *darwinIsolator) dropPackets(ctx context.Context) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	stdout, _, err := i.runner(ctx).Pfctl("", "-a", pfAnchorPath, "-vsr")
	if err != nil {
		return 0, fmt.Errorf("read the pf drop counter: %w", err)
	}
	return parsePFDropPackets(stdout)
}

// pfTokenStore is the token journal. It lives beside isolation.json rather than
// in it: the journal format is shared across OSes and the Manager owns its
// writes, so an Isolator writing to it mid-operation would be overwritten.
type pfTokenStore struct{ path string }

func (s pfTokenStore) load() (string, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	for _, c := range token {
		if c < '0' || c > '9' {
			return "", errors.New("the pf token file is corrupt")
		}
	}
	return token, nil
}

func (s pfTokenStore) save(token string) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "."+filepath.Base(s.path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	_, writeErr := tmp.WriteString(token + "\n")
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return atomicrename.Replace(tmp.Name(), s.path)
}

func (s pfTokenStore) clear() error {
	if err := os.Remove(s.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
