package hwhealth

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

const (
	stateFileName   = "hwhealth_state.json"
	quarantineInfix = ".corrupt-"
	// maxWireSequence keeps a recovered sequence representable by the server's
	// z.number().int() (JavaScript safe integer).
	maxWireSequence = uint64(1<<53 - 1)
)

var salvageSequence = regexp.MustCompile(`"sequence"\s*:\s*([0-9]{1,20})`)

// loadState reads the persisted collector state. A missing file is a normal
// first start (sequence 0). A file that cannot be read or decoded must never
// stop collection on a customer machine, so it is quarantined (keeping only the
// newest corrupt copy) and the sequence is re-seeded from a wall-clock floor:
// the old counter advanced by one per cycle, so now.UnixMilli() is strictly
// above anything the server has stored and the next snapshot is not rejected
// as stale. A still-readable "sequence" field is honoured when it is higher.
// The same floor applies when the state is missing but a quarantined copy
// exists (the process died between quarantine and the first rewrite).
//
// The returned error is informational only: it describes what was recovered.
func loadState(dir string, now time.Time) (diskState, error) {
	path := filepath.Join(dir, stateFileName)
	var s diskState
	readErr := readJSON(path, &s)
	_, statErr := os.Stat(path)
	missing := os.IsNotExist(statErr)
	switch {
	case readErr == nil && !missing:
		// Normal restart.
	case readErr == nil && missing:
		copies, _ := filepath.Glob(path + quarantineInfix + "*")
		if len(copies) == 0 {
			break
		}
		s = diskState{Sequence: recoveryFloor(now, salvage(copies[len(copies)-1]))}
		readErr = fmt.Errorf("hardware state missing after an earlier quarantine")
	default:
		salvaged := salvage(path)
		quarantineErr := quarantineState(path, now)
		s = diskState{Sequence: recoveryFloor(now, salvaged)}
		if quarantineErr != nil {
			readErr = fmt.Errorf("%w (quarantine failed: %v)", readErr, quarantineErr)
		}
	}
	if s.MDMembers == nil {
		s.MDMembers = map[string]string{}
	}
	return s, readErr
}

func recoveryFloor(now time.Time, salvaged uint64) uint64 {
	floor := uint64(0)
	if ms := now.UnixMilli(); ms > 0 {
		floor = uint64(ms)
	}
	if salvaged > floor && salvaged <= maxWireSequence {
		return salvaged
	}
	return floor
}

// salvage extracts a plausible sequence from a damaged state file; 0 if none.
func salvage(path string) uint64 {
	f, e := os.Open(path)
	if e != nil {
		return 0
	}
	// Read-only, best-effort salvage: a Close error cannot affect the bytes
	// already read, and the handle is released before quarantineState renames.
	defer func() { _ = f.Close() }()
	b, _ := io.ReadAll(io.LimitReader(f, maxHardwareStateBytes+1))
	m := salvageSequence.FindSubmatch(b)
	if m == nil {
		return 0
	}
	n, e := strconv.ParseUint(string(m[1]), 10, 64)
	if e != nil {
		return 0
	}
	return n
}

// quarantineState renames the damaged file aside, keeping only the newest copy.
func quarantineState(path string, now time.Time) error {
	old, _ := filepath.Glob(path + quarantineInfix + "*")
	for _, p := range old {
		_ = os.Remove(p)
	}
	return os.Rename(path, path+quarantineInfix+strconv.FormatInt(now.UnixMilli(), 10))
}
