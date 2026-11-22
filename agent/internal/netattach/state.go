package netattach

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"sync"

	"github.com/breeze-rmm/agent/internal/atomicrename"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("netattach")

const (
	// blockSize sequences are reserved per state-file write.
	blockSize = 1024
	// maxSequence is the largest integer a JSON number carries exactly; the
	// server parses sequence as one.
	maxSequence = 1<<53 - 1
	// maxStateFileBytes bounds what OpenState reads.
	maxStateFileBytes = 4096
)

var validEpoch = regexp.MustCompile(`^[0-9a-f]{16}$`)

// State hands out the epoch and monotonic sequence numbers for attachment
// reports. The state file records a high-water mark: every sequence this epoch
// has handed out is at most reservedThrough, so a restart resumes above
// anything sent. When that cannot be guaranteed (the file is missing, invalid,
// or cannot be written) the epoch changes, which the server treats as a reset.
type State struct {
	mu      sync.Mutex
	path    string
	persist func(path string, data []byte) error
	random  io.Reader

	epoch           string
	next            uint64
	reservedThrough uint64
	warned          bool
}

// OpenState opens the state file at path. A valid file keeps its epoch and
// resumes above its mark; a missing, unreadable, oversized or invalid file
// gets a new random epoch. The only error is a failed random source.
func OpenState(path string) (*State, error) {
	return openStateWith(path, writeStateFile, rand.Reader)
}

func openStateWith(path string, persist func(string, []byte) error, random io.Reader) (*State, error) {
	s := &State{path: path, persist: persist, random: random}
	epoch, reserved, err := readStateFile(path)
	if err == nil {
		s.epoch, s.reservedThrough, s.next = epoch, reserved, reserved+1
		return s, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		log.Warn("network attachment state unusable; starting a new epoch", "error", err.Error())
	}
	if err := s.newEpoch(); err != nil {
		return nil, err
	}
	return s, nil
}

// Next returns the epoch and the next sequence. It writes the state file once
// per block of 1,024 sequences, before handing out the first of them.
func (s *State) Next() (string, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.next == 0 || s.next > maxSequence {
		if err := s.newEpoch(); err != nil {
			return "", 0, err
		}
	}
	if s.next > s.reservedThrough {
		ceiling := min(s.next+blockSize-1, maxSequence)
		if err := s.persist(s.path, encodeState(s.epoch, ceiling)); err != nil {
			// The file may hold a mark below what this epoch has sent: never
			// continue it.
			s.warnOnce(err)
			if err := s.newEpoch(); err != nil {
				return "", 0, err
			}
			ceiling = blockSize // memory-only block; the write is retried when it is used up
		}
		s.reservedThrough = ceiling
	}
	seq := s.next
	s.next++
	return s.epoch, seq, nil
}

// newEpoch starts a fresh epoch at sequence 1 with nothing reserved.
func (s *State) newEpoch() error {
	var b [8]byte
	if _, err := io.ReadFull(s.random, b[:]); err != nil {
		return err
	}
	s.epoch = hex.EncodeToString(b[:])
	s.next = 1
	s.reservedThrough = 0
	return nil
}

func (s *State) warnOnce(err error) {
	if s.warned {
		return
	}
	s.warned = true
	log.Warn("failed to persist network attachment state; continuing under a new in-memory epoch",
		"path", s.path, "error", err.Error())
}

func encodeState(epoch string, reservedThrough uint64) []byte {
	return []byte(`{"epoch":"` + epoch + `","reservedThrough":` + strconv.FormatUint(reservedThrough, 10) + `}`)
}

var errInvalidState = errors.New("netattach: invalid state file")

// readStateFile returns the file's epoch and mark, or an error for a missing,
// unreadable, oversized or invalid file.
func readStateFile(path string) (string, uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, maxStateFileBytes+1))
	if err != nil {
		return "", 0, err
	}
	if len(raw) > maxStateFileBytes {
		return "", 0, errInvalidState
	}
	var body struct {
		Epoch           string      `json:"epoch"`
		ReservedThrough json.Number `json:"reservedThrough"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return "", 0, errInvalidState
	}
	reserved, err := strconv.ParseUint(body.ReservedThrough.String(), 10, 64)
	if err != nil || reserved > maxSequence || !validEpoch.MatchString(body.Epoch) {
		return "", 0, errInvalidState
	}
	return body.Epoch, reserved, nil
}

// writeStateFile replaces path with data, mode 0600, durably: a temp file in
// the same directory, Sync, atomicrename.Replace, then a best-effort directory
// sync off Windows (as control_plane_block.go does).
func writeStateFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".network-attachment-state-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func(e error) error {
		_ = tmp.Close()
		_ = os.Remove(name)
		return e
	}
	if err := tmp.Chmod(0o600); err != nil {
		return cleanup(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return cleanup(err)
	}
	if err := tmp.Sync(); err != nil {
		return cleanup(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := atomicrename.Replace(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	if runtime.GOOS != "windows" {
		if d, err := os.Open(filepath.Dir(path)); err == nil {
			_ = d.Sync()
			_ = d.Close()
		}
	}
	return nil
}
