package rebuild

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// enrollmentKeys are the agent.yaml keys applyNewIdentity removes so a
// rebuilt "new identity" machine re-enrolls from scratch instead of
// colliding with the source device's identity. org_id/site_id are
// deliberately KEPT — they let the fresh enrollment land back in the same
// org/site — as are server_url and every other non-identity setting.
var enrollmentKeys = []string{"agent_id", "device_id", "auth_token", "watchdog_auth_token", "helper_auth_token"}

func identity(ctx context.Context, r *run) error {
	switch r.opts.Identity {
	case IdentityOriginal:
		if r.opts.Marker == nil {
			r.warn("no recovery marker given; the server will not auto-complete this recovery")
			return nil
		}
		return writeRecoveryMarker(r, filepath.Join(r.staging, "var", "lib", "breeze"))
	case IdentityNew:
		return applyNewIdentity(r.staging)
	default:
		return fmt.Errorf("unknown identity mode %q", r.opts.Identity)
	}
}

// writeRecoveryMarker writes r.opts.Marker (non-nil) as recovery-marker.json
// in dir, the restored agent's data dir that its heartbeat reads
// (heartbeat.LoadRecoveryMarker(config.GetDataDir())): /var/lib/breeze on
// Linux, <root volume>\ProgramData\Breeze\data on Windows. Used by both
// engines.
func writeRecoveryMarker(r *run, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(map[string]string{
		"recoveryId": r.opts.Marker.RecoveryID, "nonce": r.opts.Marker.Nonce,
		"snapshotId": r.opts.SnapshotID, "completedAt": time.Now().UTC().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "recovery-marker.json"), data, 0o600)
}

// applyNewIdentity makes the tree boot as a fresh machine: empty machine-id
// (systemd regenerates it on first boot), "-restored" hostname, no
// enrollment credentials or secrets.
func applyNewIdentity(root string) error {
	_ = os.WriteFile(filepath.Join(root, "etc", "machine-id"), []byte{}, 0o644)
	_ = os.Remove(filepath.Join(root, "var", "lib", "dbus", "machine-id"))
	if hn, err := os.ReadFile(filepath.Join(root, "etc", "hostname")); err == nil {
		name := strings.TrimSpace(string(hn))
		if name != "" && !strings.HasSuffix(name, "-restored") {
			_ = os.WriteFile(filepath.Join(root, "etc", "hostname"), []byte(name+"-restored\n"), 0o644)
		}
	}
	_ = os.Remove(filepath.Join(root, "etc", "breeze", "secrets.yaml"))
	return stripEnrollment(filepath.Join(root, "etc", "breeze", "agent.yaml"))
}

// stripEnrollment deletes enrollmentKeys from an agent.yaml document,
// leaving every other setting (server_url, log_level, org_id, site_id, ...)
// untouched. A missing file is not an error — a rebuilt tree with no agent
// config yet is fine as-is.
func stripEnrollment(agentYAML string) error {
	data, err := os.ReadFile(agentYAML)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("parse %s: %w", agentYAML, err)
	}
	for _, k := range enrollmentKeys {
		delete(doc, k)
	}
	out, err := yaml.Marshal(doc)
	if err != nil {
		return err
	}
	return os.WriteFile(agentYAML, out, 0o644)
}

// encryption is a recorded no-op on the Linux engine: LUKS sources are
// refused at preflight (layout.Assess's ReasonLUKS guard) and BitLocker is
// the Windows engine's job (a later wave). The phase still appears in
// Result.Phases (as skipped) so every platform reports the same phases.
func encryption(_ context.Context, r *run) error {
	r.recordSkipped(PhaseEncryption, "no encryption to re-apply on the Linux engine")
	return nil
}
