package timesync

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

const stateName = "timesync-state.json"
const maxStateBytes = 4 * 1024 * 1024

var salvageCounter = regexp.MustCompile(`"sequence"\s*:\s*([0-9]{1,20})`)

type diskState struct {
	Sequence    uint64    `json:"sequence"`
	EventsSince time.Time `json:"eventsSince"`
}

func writeState(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(b) > maxStateBytes {
		return fmt.Errorf("time sync state exceeds 4 MiB")
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp) }()
	if _, err = f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(25 * time.Millisecond << uint(attempt-1))
		}
		if err = os.Rename(tmp, path); err == nil {
			return nil
		}
	}
	return fmt.Errorf("replace time sync state after 4 attempts: %w", err)
}
func readState(path string, now time.Time) (diskState, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, e := os.Stat(path + ".corrupt"); e == nil {
			return diskState{Sequence: sequenceFloor(now, 0)}, nil
		}
		return diskState{}, nil
	}
	if err != nil {
		return diskState{}, err
	}
	b, readErr := io.ReadAll(io.LimitReader(f, maxStateBytes+1))
	_ = f.Close()
	if readErr != nil {
		return diskState{}, readErr
	}
	var state diskState
	decodeErr := json.Unmarshal(b, &state)
	if len(b) <= maxStateBytes && decodeErr == nil && state.Sequence <= maxSafeSequence {
		return state, nil
	}
	floor := uint64(0)
	if match := salvageCounter.FindSubmatch(b); len(match) == 2 {
		floor, _ = strconv.ParseUint(string(match[1]), 10, 64)
	}
	_ = os.Remove(path + ".corrupt")
	if err = os.Rename(path, path+".corrupt"); err != nil {
		return diskState{}, fmt.Errorf("quarantine time sync state: %w", err)
	}
	slog.Warn("recovered corrupt time sync state; recent events will be replayed")
	return diskState{Sequence: sequenceFloor(now, floor)}, nil
}
func sequenceFloor(now time.Time, salvaged uint64) uint64 {
	floor := uint64(0)
	if now.UnixMilli() > 0 {
		floor = uint64(now.UnixMilli())
	}
	if salvaged > floor && salvaged <= maxSafeSequence {
		floor = salvaged
	}
	return floor
}
