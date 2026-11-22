package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// #8318 review: only a staged file that was read completely and is provably
// corrupt may be moved aside. Any failure to read it (I/O, a scan holding it,
// permissions, an owner the trust check could not verify) or a format this
// build does not know leaves it in place: it may hold a confirmed set, the
// only copy of the credentials the server now accepts.
func TestReadRebindStagedMovesAsideOnlyProvablyCorruptFiles(t *testing.T) {
	confirmed, err := json.Marshal(rebindTestSet(RebindPhaseConfirmed))
	if err != nil {
		t.Fatal(err)
	}
	invalid := rebindTestSet(RebindPhaseConfirmed)
	invalid.AuthToken = "not-a-token"
	invalidJSON, _ := json.Marshal(invalid)

	cases := []struct {
		name        string
		content     []byte
		readErr     error
		wantCorrupt bool
	}{
		{name: "permission denied", content: confirmed, readErr: fs.ErrPermission},
		{name: "sharing violation", content: confirmed, readErr: errors.New("The process cannot access the file because it is being used by another process.")},
		{name: "I/O error", content: confirmed, readErr: errors.New("read rebind-staged.json: input/output error")},
		{name: "owner not verified", content: confirmed, readErr: fmt.Errorf("%w: owner: %w", ErrConfigDirUntrusted, errConfigOwnerUnverified)},
		{name: "owner untrusted", content: confirmed, readErr: fmt.Errorf("%w: owned by a standard user", ErrConfigDirUntrusted)},
		{name: "newer format version", content: []byte(`{"version":2,"phase":"confirmed","something":{"new":true}}`)},
		{name: "not JSON", content: []byte(`{"version":1,"phase":"confir`), wantCorrupt: true},
		{name: "a version-1 set that fails validation", content: invalidJSON, wantCorrupt: true},
		{name: "no version", content: []byte(`{"phase":"confirmed"}`), wantCorrupt: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfgPath := bindConfig(t)
			path := RebindStagedPath(cfgPath)
			if err := os.WriteFile(path, tc.content, 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.readErr != nil {
				orig := rebindReadFileFn
				t.Cleanup(func() { rebindReadFileFn = orig })
				rebindReadFileFn = func(string) ([]byte, error) { return nil, tc.readErr }
			}

			s, err := ReadRebindStaged(cfgPath)
			if s != nil || err == nil {
				t.Fatalf("ReadRebindStaged = (%v, %v), want an error", s, err)
			}
			if got := errors.Is(err, ErrRebindStagedUnusable); got != tc.wantCorrupt {
				t.Fatalf("corrupt = %v (%v), want %v", got, err, tc.wantCorrupt)
			}
			aside, _ := filepath.Glob(path + ".unusable-*")
			onDisk, statErr := os.ReadFile(path)
			if tc.wantCorrupt {
				if !os.IsNotExist(statErr) || len(aside) != 1 {
					t.Fatalf("a corrupt file must be moved aside (kept): in place=%v aside=%v", statErr == nil, aside)
				}
				return
			}
			if !errors.Is(err, ErrRebindStagedUnreadable) {
				t.Fatalf("err = %v, want ErrRebindStagedUnreadable (retryable)", err)
			}
			if statErr != nil || !bytes.Equal(onDisk, tc.content) || len(aside) != 0 {
				t.Fatal("a file that could not be read was moved or changed")
			}
			if tc.readErr != nil {
				rebindReadFileFn = readConfigFileBytes
				if s, err := ReadRebindStaged(cfgPath); err != nil || s == nil || s.Phase != RebindPhaseConfirmed {
					t.Fatalf("after the fault cleared the read = (%v, %v), want the confirmed set", s, err)
				}
			}
		})
	}
}
