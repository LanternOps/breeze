package oemupdates

import (
	"encoding/json"
	"errors"
	"io/fs"
	"sort"
	"sync"
	"time"
)

const (
	pendingFile        = "verify.json"
	pendingCorruptFile = "verify.json.corrupt"
	// maxPendingVerifications bounds the file. Two firmware runs without a
	// reboot between them is already unusual.
	maxPendingVerifications = 8
	// maxVerifyAge is how long a verification waits for a reboot and a
	// reachable API. Past it the API's not-returned monitor has long spoken.
	maxVerifyAge = 7 * 24 * time.Hour
)

// PendingVerification is a firmware install whose post-reboot state has not
// been reported yet. It is kept apart from the run marker, keyed by command, so
// a later run cannot overwrite it.
type PendingVerification struct {
	CommandID         string    `json:"commandId"`
	VerifyAfter       time.Time `json:"verifyAfter"`
	BiosVersionBefore string    `json:"biosVersionBefore,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
}

// pendingMu serialises read-modify-write of the pending file. A run and the
// startup verifier both write it.
var pendingMu sync.Mutex

func readPendingVerifications(store Store) ([]PendingVerification, error) {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	return readPendingLocked(store)
}

func readPendingLocked(store Store) ([]PendingVerification, error) {
	data, err := store.ReadFile(pendingFile)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var list []PendingVerification
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	return list, nil
}

func writePendingLocked(store Store, list []PendingVerification) error {
	if len(list) == 0 {
		return store.Remove(pendingFile)
	}
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	return store.WriteFile(pendingFile, data)
}

// addPendingVerification records or replaces p, keeping the newest entries.
func addPendingVerification(store Store, p PendingVerification) error {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	list, err := readPendingLocked(store)
	if err != nil {
		// An unreadable file must not block recording a flash. Its entries
		// are earlier flashes still owed a check, so the bytes are kept beside
		// it for a person to read rather than overwritten.
		if raw, rerr := store.ReadFile(pendingFile); rerr == nil {
			if werr := store.WriteFile(pendingCorruptFile, raw); werr != nil {
				log.Error("could not keep an unreadable pending-verification file; earlier entries are lost", "error", werr.Error())
			}
		}
		log.Error("pending vendor update verifications unreadable; kept as "+pendingCorruptFile+" and replaced", "error", err.Error())
		list = nil
	}
	next := make([]PendingVerification, 0, len(list)+1)
	for _, e := range list {
		if e.CommandID != p.CommandID {
			next = append(next, e)
		}
	}
	next = append(next, p)
	sort.SliceStable(next, func(i, j int) bool { return next[i].CreatedAt.Before(next[j].CreatedAt) })
	if len(next) > maxPendingVerifications {
		next = next[len(next)-maxPendingVerifications:]
	}
	return writePendingLocked(store, next)
}

func removePendingVerification(store Store, commandID string) error {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	list, err := readPendingLocked(store)
	if err != nil {
		return err
	}
	next := list[:0:0]
	for _, e := range list {
		if e.CommandID != commandID {
			next = append(next, e)
		}
	}
	if len(next) == len(list) {
		return nil
	}
	return writePendingLocked(store, next)
}
