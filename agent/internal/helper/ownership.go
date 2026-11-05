package helper

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Install ownership (OD-8 (a), #10185). The agent manages only the Breeze
// Assist installs it made. Each successful agent install or update writes an
// ownership marker; the agent uninstalls only an install whose marker is
// present. An install without one (an MSP pushed the MSI through Intune or a
// software policy) is left alone while deploy is off and reported as
// unmanaged_install. With deploy on the agent runs such a copy and adopts it
// when it installs the next server-offered version over it.
//
// The record lives in the agent's config dir (Windows: a PROTECTED
// SYSTEM+Administrators DACL whose Users ACE is read-only and not
// inheritable), so a user cannot plant a marker to have the agent remove
// software, or delete it to keep the agent's own install.

// ownershipFileName is the ownership record in Manager.baseDir.
const ownershipFileName = "assist-ownership.json"

// ownershipInstalledByAgent is the only InstalledBy value the agent treats as
// its own install.
const ownershipInstalledByAgent = "breeze-agent"

const maxOwnershipFileBytes = 4096

// ownershipMarker records an Assist install the agent made (or adopted).
type ownershipMarker struct {
	InstalledBy string    `json:"installedBy"`
	Version     string    `json:"version,omitempty"`
	InstalledAt time.Time `json:"installedAt"`
}

// ownershipFile is the on-disk record. Its presence means this host has run an
// ownership-aware agent; Managed is set only while an agent-made install
// exists. Keeping "tracking started" in the same file makes the upgrade-time
// adoption below a one-shot.
type ownershipFile struct {
	Managed *ownershipMarker `json:"managed,omitempty"`
}

var errOwnershipMalformed = errors.New("assist ownership record is malformed")

// loadOwnershipFile reads the record. present is false only when the file does
// not exist; any other read or parse failure is errOwnershipMalformed with
// present true, so an unreadable record is never mistaken for a first run.
func loadOwnershipFile(dir string) (ownershipFile, bool, error) {
	f, err := os.Open(filepath.Join(dir, ownershipFileName))
	if errors.Is(err, os.ErrNotExist) {
		return ownershipFile{}, false, nil
	}
	if err != nil {
		return ownershipFile{}, true, fmt.Errorf("%w: %v", errOwnershipMalformed, err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxOwnershipFileBytes+1))
	if err != nil {
		return ownershipFile{}, true, fmt.Errorf("%w: %v", errOwnershipMalformed, err)
	}
	if len(data) > maxOwnershipFileBytes {
		return ownershipFile{}, true, fmt.Errorf("%w: larger than %d bytes", errOwnershipMalformed, maxOwnershipFileBytes)
	}
	var rec ownershipFile
	if err := json.Unmarshal(data, &rec); err != nil {
		return ownershipFile{}, true, fmt.Errorf("%w: %v", errOwnershipMalformed, err)
	}
	return rec, true, nil
}

// readOwnership returns the marker when the record names an agent-made install.
func readOwnership(dir string) (ownershipMarker, bool) {
	rec, _, err := loadOwnershipFile(dir)
	if err != nil || rec.Managed == nil || rec.Managed.InstalledBy != ownershipInstalledByAgent {
		return ownershipMarker{}, false
	}
	return *rec.Managed, true
}

// ownershipTracked reports whether an ownership record exists at all.
func ownershipTracked(dir string) bool {
	_, present, _ := loadOwnershipFile(dir)
	return present
}

// writeOwnership records m as the current install.
func writeOwnership(dir string, m ownershipMarker) error {
	return storeOwnershipFile(dir, ownershipFile{Managed: &m})
}

// clearOwnership records that no agent-made install exists, keeping tracking.
func clearOwnership(dir string) error {
	return storeOwnershipFile(dir, ownershipFile{})
}

// storeOwnershipFile writes atomically (temp file + rename). It does not
// create dir: the agent's config dir exists wherever the agent runs.
func storeOwnershipFile(dir string, rec ownershipFile) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal assist ownership: %w", err)
	}
	path := filepath.Join(dir, ownershipFileName)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write assist ownership: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename assist ownership: %w", err)
	}
	return nil
}

// installIsOursLocked decides whether the install on disk (if any) is the
// agent's, applying the one-shot upgrade adoption on the first Apply of an
// ownership-aware build:
//   - deploy on and Assist installed: today's agent manages that install, so
//     it is marked as the agent's;
//   - deploy off and Assist installed: today's agent would already have
//     removed its own install, so this one is someone else's.
//
// Once a record exists, the marker counts only while the install it describes
// is still there: a marker left with no binary behind it (an admin removed
// Assist, or clearing it after the agent's own uninstall failed) is cleared,
// and an installed version other than the one recorded means someone else
// installed over the agent's copy.
//
// A record that cannot be read or written fails toward "not ours": the cost is
// a copy the agent leaves installed, never software it removes by mistake.
// Must be called with m.mu held.
func (m *Manager) installIsOursLocked(installed, enabled bool) bool {
	if m.pendingOwnershipMark != nil {
		// The marker write after the agent's own install failed: retry it.
		// Until it lands, this process knows the install is the agent's.
		if !installed {
			m.pendingOwnershipMark = nil
		} else if err := writeOwnership(m.baseDir, *m.pendingOwnershipMark); err != nil {
			return true
		} else {
			log.Info("recorded breeze assist ownership after an earlier failed write", "version", m.pendingOwnershipMark.Version)
			m.pendingOwnershipMark = nil
		}
	}
	rec, present, err := loadOwnershipFile(m.baseDir)
	if err != nil {
		if !m.ownershipErrLogged {
			log.Warn("breeze assist ownership record unreadable; treating the install as not the agent's",
				"error", err.Error())
			m.ownershipErrLogged = true
		}
		if !installed {
			m.resetOwnershipRecordLocked()
		}
		return false
	}
	m.ownershipErrLogged = false
	if !present {
		return m.adoptOnFirstApplyLocked(installed, enabled)
	}
	if rec.Managed == nil || rec.Managed.InstalledBy != ownershipInstalledByAgent {
		return false
	}
	if !installed {
		m.resetOwnershipRecordLocked()
		return false
	}
	// Compared only against the version stamped in the binary (Windows,
	// macOS): the session status files lag an update until Assist restarts.
	if v, verr := m.readBinaryVersion(); verr == nil && v != "" && rec.Managed.Version != "" &&
		!helperVersionsMatch(v, rec.Managed.Version) {
		if key := rec.Managed.Version + ">" + v; m.ownershipMismatchLogged != key {
			log.Warn("installed breeze assist is not the version the agent installed; treating it as not the agent's",
				"recordedVersion", rec.Managed.Version, "installedVersion", v)
			m.ownershipMismatchLogged = key
		}
		return false
	}
	m.ownershipMismatchLogged = ""
	return true
}

// adoptOnFirstApplyLocked is the one-shot upgrade adoption described above.
// Must be called with m.mu held.
func (m *Manager) adoptOnFirstApplyLocked(installed, enabled bool) bool {
	if installed && enabled {
		marker := ownershipMarker{
			InstalledBy: ownershipInstalledByAgent,
			Version:     m.installedVersionLocked(),
			InstalledAt: m.nowTime(),
		}
		if err := writeOwnership(m.baseDir, marker); err != nil {
			log.Warn("failed to record the installed breeze assist as agent-managed; retrying on the next heartbeat",
				"error", err.Error())
			m.pendingOwnershipMark = &marker
		} else {
			log.Info("recorded the installed breeze assist as agent-managed (deploy is on)", "version", marker.Version)
		}
		return true
	}
	if err := clearOwnership(m.baseDir); err != nil {
		log.Warn("failed to start breeze assist ownership tracking", "error", err.Error())
	}
	return false
}

// resetOwnershipRecordLocked records that no agent-made install exists. If
// that write fails it removes the record instead, so a stale marker never
// outlives the install it described: the next Apply then re-runs the
// first-Apply rule, under which an install found with deploy off is not the
// agent's. Must be called with m.mu held.
func (m *Manager) resetOwnershipRecordLocked() {
	err := clearOwnership(m.baseDir)
	if err == nil {
		return
	}
	path := filepath.Join(m.baseDir, ownershipFileName)
	if rmErr := os.Remove(path); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
		log.Warn("failed to clear the breeze assist ownership record", "error", err.Error(), "removeError", rmErr.Error())
	}
}

// markInstalledLocked records an install the agent just made. A failed write
// is retried on later Applies (installIsOursLocked); meanwhile this process
// treats the install as its own. Must be called with m.mu held.
func (m *Manager) markInstalledLocked(version string) {
	marker := ownershipMarker{InstalledBy: ownershipInstalledByAgent, Version: version, InstalledAt: m.nowTime()}
	if err := writeOwnership(m.baseDir, marker); err != nil {
		log.Warn("failed to record breeze assist ownership after install; retrying on the next heartbeat",
			"version", version, "error", err.Error())
		m.pendingOwnershipMark = &marker
		return
	}
	m.pendingOwnershipMark = nil
}

// remarkInstalledLocked re-records the agent's install at the version now on
// disk after an update rollback put the previous build back: the marker named
// the build that was rolled back. Must be called with m.mu held.
func (m *Manager) remarkInstalledLocked() {
	if _, ok := readOwnership(m.baseDir); !ok && m.pendingOwnershipMark == nil {
		return
	}
	if v, err := m.readBinaryVersion(); err == nil && v != "" {
		m.markInstalledLocked(v)
	}
}
