package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/atomicrename"
)

// The MSP's support name (#8928) is the {s} of the PAM notice copy ("Request
// sent to Contoso IT"). The server returns it with a successful elevation
// submit, but the offline notice fires exactly when a submit fails — so the
// last non-empty value is cached in memory and persisted in a sidecar next to
// the PAM lifetime ledger. It is deliberately not part of agent.state, which
// agentapp rewrites on every start and stop.
//
// A device that has never completed a submit has no name and the copy says
// "IT".

const pamSupportNameFile = "pam-support-name.json"

type pamSupportNameState struct {
	SupportName string `json:"supportName"`
}

// pamSupportNamePath is the sidecar path, or "" when no state path is set
// (the name is then memory-only).
func (h *Heartbeat) pamSupportNamePath() string {
	if h.statePath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(h.statePath), pamSupportNameFile)
}

// lastSupportName returns the cached support name, or "" when none is known.
// The copy helpers apply the "IT" fallback.
func (h *Heartbeat) lastSupportName() string {
	h.pamSupportNameMu.Lock()
	defer h.pamSupportNameMu.Unlock()
	return h.pamSupportNameCached
}

// rememberSupportName caches s (trimmed, capped at 120 runes) and persists it
// when it changed. Empty values are ignored: a server that omits the name
// must not erase one learned earlier.
func (h *Heartbeat) rememberSupportName(s string) {
	name := clampSupportName(s)
	if name == "" {
		return
	}
	h.pamSupportNameMu.Lock()
	defer h.pamSupportNameMu.Unlock()
	if name == h.pamSupportNameCached {
		return
	}
	h.pamSupportNameCached = name
	path := h.pamSupportNamePath()
	if path == "" {
		return
	}
	if err := writePamSupportName(path, name); err != nil {
		// Non-fatal: the in-memory value still serves this process.
		log.Warn("pam: failed to persist support name", "path", path, "error", err.Error())
	}
}

// loadPamSupportName reads the sidecar into the cache. A missing file is the
// normal state before the first submit; a corrupt one is logged and treated
// as empty.
func (h *Heartbeat) loadPamSupportName() {
	path := h.pamSupportNamePath()
	name := ""
	if path != "" {
		name = readPamSupportName(path)
	}
	h.pamSupportNameMu.Lock()
	h.pamSupportNameCached = name
	h.pamSupportNameMu.Unlock()
}

func readPamSupportName(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			log.Debug("pam: no persisted support name yet", "path", path)
		} else {
			log.Warn("pam: failed to read persisted support name; using IT", "path", path, "error", err.Error())
		}
		return ""
	}
	var st pamSupportNameState
	if err := json.Unmarshal(raw, &st); err != nil {
		log.Warn("pam: persisted support name is corrupt; using IT", "path", path, "error", err.Error())
		return ""
	}
	return clampSupportName(st.SupportName)
}

// writePamSupportName persists name as a 0600 temp file renamed over the
// sidecar with atomicrename.Replace (which tolerates a reader holding the old
// file open on Windows).
func writePamSupportName(path, name string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create support name directory: %w", err)
	}
	raw, err := json.Marshal(pamSupportNameState{SupportName: name})
	if err != nil {
		return fmt.Errorf("encode support name: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".pam-support-name-*")
	if err != nil {
		return fmt.Errorf("create support name temporary file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("secure support name temporary file: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write support name: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("flush support name: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close support name: %w", err)
	}
	if err := atomicrename.Replace(tmpPath, path); err != nil {
		return fmt.Errorf("replace support name: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("secure support name: %w", err)
	}
	return nil
}
