package netattach

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
)

var epochPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

func statePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "network-attachment-state.json")
}

// stateFromFile writes body to a temp state file and opens it.
func stateFromFile(t *testing.T, body string) *State {
	t.Helper()
	path := statePath(t)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := OpenState(path)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

type stateFile struct {
	Epoch           string `json:"epoch"`
	ReservedThrough uint64 `json:"reservedThrough"`
}

func readState(t *testing.T, path string) stateFile {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f stateFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("state file %q: %v", raw, err)
	}
	return f
}

func mustNext(t *testing.T, st *State) (string, uint64) {
	t.Helper()
	epoch, seq, err := st.Next()
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	return epoch, seq
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("no entropy") }

func TestOpenState_MissingFileCreatesEpoch(t *testing.T) {
	path := statePath(t)
	st, err := OpenState(path)
	if err != nil {
		t.Fatal(err)
	}
	epoch, seq := mustNext(t, st)
	if !epochPattern.MatchString(epoch) || seq != 1 {
		t.Fatalf("Next = %q, %d", epoch, seq)
	}
	if f := readState(t, path); f != (stateFile{epoch, 1024}) {
		t.Fatalf("file = %+v", f)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, %v", info.Mode(), err)
		}
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".network-attachment-state-*")); len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

func TestState_SequenceSurvivesRestart(t *testing.T) {
	path := statePath(t)
	s1, err := OpenState(path)
	if err != nil {
		t.Fatal(err)
	}
	var epoch string
	for want := uint64(1); want <= 3; want++ {
		e, seq := mustNext(t, s1)
		if seq != want || (epoch != "" && e != epoch) {
			t.Fatalf("s1 Next = %q, %d; want seq %d, epoch %q", e, seq, want, epoch)
		}
		epoch = e
	}
	for _, want := range []uint64{1025, 2049} {
		s, err := OpenState(path)
		if err != nil {
			t.Fatal(err)
		}
		if e, seq := mustNext(t, s); e != epoch || seq != want {
			t.Fatalf("after restart Next = %q, %d; want %q, %d", e, seq, epoch, want)
		}
	}
}

func TestState_PersistsOncePerBlock(t *testing.T) {
	writes := 0
	st, err := openStateWith(statePath(t), func(path string, data []byte) error { writes++; return writeStateFile(path, data) }, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for range 2048 {
		mustNext(t, st)
	}
	if writes != 2 {
		t.Fatalf("2048 Next → %d writes, want 2", writes)
	}
	if _, seq := mustNext(t, st); seq != 2049 || writes != 3 {
		t.Fatalf("2049th Next → seq %d, %d writes, want 3", seq, writes)
	}
}

func TestOpenState_CorruptFileGetsNewEpoch(t *testing.T) {
	for _, body := range []string{
		`{not json`,
		`{"epoch":"XYZ","reservedThrough":5}`,
		`{"epoch":"9f2c1e7ab4d04c11","reservedThrough":-1}`,
		`{"epoch":"9f2c1e7ab4d04c11","reservedThrough":9007199254740992}`,
		`{"epoch":"9f2c1e7ab4d04c11","reservedThrough":1.5}`,
		`{"epoch":"9f2c1e7ab4d04c11"}`,
		`{"epoch":"9F2C1E7AB4D04C11","reservedThrough":5}`,
		`{"reservedThrough":5}`,
		`[]`,
		strings.Repeat(" ", 5000),
		`{"epoch":"9f2c1e7ab4d04c11","reservedThrough":5}` + strings.Repeat(" ", 5000),
	} {
		name := body
		if len(name) > 60 {
			name = name[:20] + "…(long)"
		}
		t.Run(name, func(t *testing.T) {
			path := statePath(t)
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			st, err := OpenState(path)
			if err != nil {
				t.Fatal(err)
			}
			epoch, seq := mustNext(t, st)
			if !epochPattern.MatchString(epoch) || epoch == "9f2c1e7ab4d04c11" || seq != 1 {
				t.Fatalf("Next = %q, %d", epoch, seq)
			}
			if f := readState(t, path); f.Epoch != epoch {
				t.Fatalf("file = %+v, want epoch %q", f, epoch)
			}
		})
	}
}

func TestOpenState_ValidFileResumesAboveMark(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`)
	if epoch, seq := mustNext(t, st); epoch != "9f2c1e7ab4d04c11" || seq != 418 {
		t.Fatalf("Next = %q, %d; want 9f2c1e7ab4d04c11, 418", epoch, seq)
	}
}

func TestState_PersistFailureRotatesEpoch(t *testing.T) {
	path := statePath(t)
	if err := os.WriteFile(path, []byte(`{"epoch":"9f2c1e7ab4d04c11","reservedThrough":417}`), 0o600); err != nil {
		t.Fatal(err)
	}
	failing := true
	attempts := 0
	st, err := openStateWith(path, func(p string, data []byte) error {
		attempts++
		if failing {
			return errors.New("disk full")
		}
		return writeStateFile(p, data)
	}, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	epoch, seq := mustNext(t, st)
	if epoch == "9f2c1e7ab4d04c11" || !epochPattern.MatchString(epoch) || seq != 1 {
		t.Fatalf("Next after failed write = %q, %d", epoch, seq)
	}
	if e, s := mustNext(t, st); e != epoch || s != 2 || attempts != 1 {
		t.Fatalf("second Next = %q, %d with %d write attempts", e, s, attempts)
	}
	failing = false
	for want := uint64(3); want <= 1024; want++ {
		if _, s := mustNext(t, st); s != want {
			t.Fatalf("seq %d, want %d", s, want)
		}
	}
	if attempts != 1 {
		t.Fatalf("%d write attempts inside the memory-only block, want 1", attempts)
	}
	if e, s := mustNext(t, st); e != epoch || s != 1025 || attempts != 2 {
		t.Fatalf("1025th Next = %q, %d with %d attempts", e, s, attempts)
	}
	if f := readState(t, path); f != (stateFile{epoch, 2048}) {
		t.Fatalf("file = %+v, want {%s 2048}", f, epoch)
	}
}

func TestState_RotatesAtSafeIntegerLimit(t *testing.T) {
	st := stateFromFile(t, `{"epoch":"9f2c1e7ab4d04c11","reservedThrough":9007199254740991}`)
	if epoch, seq := mustNext(t, st); epoch == "9f2c1e7ab4d04c11" || seq != 1 {
		t.Fatalf("Next = %q, %d", epoch, seq)
	}
}

func TestState_CeilingNeverPassesSafeIntegerLimit(t *testing.T) {
	path := statePath(t)
	if err := os.WriteFile(path, []byte(`{"epoch":"9f2c1e7ab4d04c11","reservedThrough":9007199254740000}`), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := OpenState(path)
	if err != nil {
		t.Fatal(err)
	}
	if epoch, seq := mustNext(t, st); epoch != "9f2c1e7ab4d04c11" || seq != 9007199254740001 {
		t.Fatalf("Next = %q, %d", epoch, seq)
	}
	if f := readState(t, path); f.ReservedThrough != maxSequence {
		t.Fatalf("ceiling = %d, want %d", f.ReservedThrough, uint64(maxSequence))
	}
}

func TestState_RandomFailure(t *testing.T) {
	if _, err := openStateWith(statePath(t), writeStateFile, failingReader{}); err == nil {
		t.Fatal("OpenState with a failing random source returned no error")
	}
}

func TestState_ConcurrentNextIsUnique(t *testing.T) {
	st, err := OpenState(statePath(t))
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	seen := map[uint64]bool{}
	epochs := map[string]bool{}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 300 {
				epoch, seq, err := st.Next()
				if err != nil {
					t.Error(err)
					return
				}
				mu.Lock()
				seen[seq] = true
				epochs[epoch] = true
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if len(seen) != 2400 || len(epochs) != 1 {
		t.Fatalf("%d distinct sequences, %d epochs", len(seen), len(epochs))
	}
}
