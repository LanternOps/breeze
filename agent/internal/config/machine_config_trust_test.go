package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/spf13/viper"
)

const testAdminMemberSID = "S-1-5-21-1111111111-2222222222-3333333333-500"

// stubAdminLookup replaces the membership lookup and clears the verdict
// cache, so each test sees only its own answers.
func stubAdminLookup(t *testing.T, fn func(sid string) (bool, error)) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	orig := adminGroupMemberFn
	adminGroupMemberFn = func(sid string) (bool, error) {
		calls.Add(1)
		return fn(sid)
	}
	resetConfigOwnerVerdictCache()
	t.Cleanup(func() {
		adminGroupMemberFn = orig
		resetConfigOwnerVerdictCache()
	})
	return &calls
}

func TestConfigOwnerVerdict(t *testing.T) {
	for _, tc := range []struct {
		name string
		sid  string
		fn   func(string) (bool, error)
		want configOwnerVerdict
	}{
		{"SYSTEM needs no lookup", sidLocalSystem, nil, configOwnerTrusted},
		{"Administrators needs no lookup", sidAdministrators, nil, configOwnerTrusted},
		{"TrustedInstaller needs no lookup", sidTrustedInstaller, nil, configOwnerTrusted},
		{"an administrator account", testAdminMemberSID, func(string) (bool, error) { return true, nil }, configOwnerTrusted},
		{"a standard user", testUserSID, func(string) (bool, error) { return false, nil }, configOwnerUntrusted},
		{"an account that no longer exists", testUserSID, func(string) (bool, error) { return false, errAccountNotFound }, configOwnerUntrusted},
		{"a lookup that fails", testUserSID, func(string) (bool, error) { return false, errors.New("the domain is unreachable") }, configOwnerUnverified},
		{"no owner", "", nil, configOwnerUntrusted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := stubAdminLookup(t, func(sid string) (bool, error) {
				if tc.fn == nil {
					t.Fatalf("looked up %s, which needs no lookup", sid)
				}
				return tc.fn(sid)
			})
			if got := configOwnerVerdictFor(tc.sid); got != tc.want {
				t.Errorf("verdict = %v, want %v", got, tc.want)
			}
			if tc.fn == nil && calls.Load() != 0 {
				t.Errorf("%d lookups for an owner that needs none", calls.Load())
			}
		})
	}
}

// TestConfigOwnerVerdictBoundsASlowLookup: a membership lookup that does not
// answer in time counts as unverified, so a slow domain cannot hold up a
// service start.
func TestConfigOwnerVerdictBoundsASlowLookup(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	stubAdminLookup(t, func(string) (bool, error) {
		<-release
		return true, nil
	})
	orig := adminLookupTimeout
	adminLookupTimeout = 50 * time.Millisecond
	t.Cleanup(func() { adminLookupTimeout = orig })

	start := time.Now()
	if got := configOwnerVerdictFor(testAdminMemberSID); got != configOwnerUnverified {
		t.Errorf("verdict = %v, want unverified", got)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("verdict took %s", elapsed)
	}
}

// TestConfigOwnerVerdictIsCached: one lookup per account, so a folder with
// several entries the same account owns costs one lookup.
func TestConfigOwnerVerdictIsCached(t *testing.T) {
	calls := stubAdminLookup(t, func(string) (bool, error) { return true, nil })
	for i := 0; i < 3; i++ {
		configOwnerVerdictFor(testAdminMemberSID)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("%d lookups, want 1", n)
	}
}

func TestCheckConfigObjectTrust(t *testing.T) {
	stubAdminLookup(t, func(sid string) (bool, error) {
		switch sid {
		case testAdminMemberSID:
			return true, nil
		case "S-1-5-21-9-9-9-1234":
			return false, errors.New("the domain is unreachable")
		}
		return false, nil
	})
	clean := hardenedDirSecurity()
	with := func(mutate func(*programDataPathSecurity)) programDataPathSecurity {
		s := clean
		s.ACEs = append([]programDataACE(nil), clean.ACEs...)
		mutate(&s)
		return s
	}
	for _, tc := range []struct {
		name           string
		sec            programDataPathSecurity
		wantErr        string
		wantUnverified bool
	}{
		{name: "SYSTEM owner, agent DACL", sec: clean},
		{name: "Users may read", sec: with(func(s *programDataPathSecurity) {
			s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testReadExecute, SID: testUsersSID})
		})},
		{name: "owned by an administrator account that may write it", sec: with(func(s *programDataPathSecurity) {
			s.OwnerSID = testAdminMemberSID
			s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: testAdminMemberSID})
		})},
		{name: "owned by a standard user", sec: with(func(s *programDataPathSecurity) { s.OwnerSID = testUserSID }), wantErr: "owned by"},
		{name: "Users may write", sec: with(func(s *programDataPathSecurity) {
			s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testWriteData, SID: testUsersSID})
		}), wantErr: "lets " + testUsersSID + " change it"},
		{name: "a standard user may change its permissions", sec: with(func(s *programDataPathSecurity) {
			s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testWriteDAC, SID: testUserSID})
		}), wantErr: "lets " + testUserSID},
		{name: "no DACL", sec: with(func(s *programDataPathSecurity) { s.DACLPresent = false; s.ACEs = nil }), wantErr: "no DACL"},
		{name: "a link", sec: programDataPathSecurity{Exists: true, Reparse: true, NameSurrogate: true}, wantErr: "link"},
		{name: "another reparse point", sec: with(func(s *programDataPathSecurity) { s.Reparse = true }), wantErr: "reparse point"},
		{name: "owner that cannot be checked", sec: with(func(s *programDataPathSecurity) { s.OwnerSID = "S-1-5-21-9-9-9-1234" }), wantUnverified: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := checkConfigObjectTrust(`C:\ProgramData\Breeze\agent.yaml`, tc.sec)
			switch {
			case tc.wantErr == "" && !tc.wantUnverified:
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				return
			case err == nil:
				t.Fatal("accepted")
			}
			if !errors.Is(err, ErrConfigDirUntrusted) {
				t.Errorf("err = %v, want ErrConfigDirUntrusted", err)
			}
			if got := errors.Is(err, errConfigOwnerUnverified); got != tc.wantUnverified {
				t.Errorf("unverified = %v, want %v (err %v)", got, tc.wantUnverified, err)
			}
			if tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("err = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

// TestReplaceEvidenceOnlyCountsTheAgentsOwnEntries: the folder is replaced
// when another account owns the folder itself, a config file or one of the
// agent's own subfolders — not because of some other file in it (an older
// Helper's status file, say), which is set aside on its own instead.
func TestReplaceEvidenceOnlyCountsTheAgentsOwnEntries(t *testing.T) {
	stubAdminLookup(t, func(sid string) (bool, error) {
		if sid == "S-1-5-21-9-9-9-1234" {
			return false, errors.New("the domain is unreachable")
		}
		return false, nil
	})
	trusted := hardenedDirSecurity()
	userOwned := trusted
	userOwned.OwnerSID = testUserSID
	unchecked := trusted
	unchecked.OwnerSID = "S-1-5-21-9-9-9-1234"
	link := programDataPathSecurity{Exists: true, Reparse: true, NameSurrogate: true}

	for _, tc := range []struct {
		name           string
		root           programDataPathSecurity
		entries        map[string]programDataPathSecurity
		wantEvidence   string
		wantForeign    []string
		wantUnverified bool
	}{
		{name: "all the agent's", root: trusted, entries: map[string]programDataPathSecurity{"agent.yaml": trusted, "data": trusted}},
		{name: "folder owned by a standard user", root: userOwned, wantEvidence: "folder owner"},
		{name: "agent.yaml owned by a standard user", root: trusted, entries: map[string]programDataPathSecurity{"agent.yaml": userOwned}, wantEvidence: "agent.yaml"},
		{name: "SECRETS.YAML in another case", root: trusted, entries: map[string]programDataPathSecurity{"SECRETS.YAML": userOwned}, wantEvidence: "SECRETS.YAML"},
		{name: "data is a link", root: trusted, entries: map[string]programDataPathSecurity{"data": link}, wantEvidence: "data is a link"},
		{name: "logs owned by a standard user", root: trusted, entries: map[string]programDataPathSecurity{"logs": userOwned}, wantEvidence: "logs"},
		{name: "another file a standard user owns", root: trusted,
			entries:     map[string]programDataPathSecurity{"agent.yaml": trusted, "helper_status.yaml": userOwned, "notes.lnk": link},
			wantForeign: []string{"helper_status.yaml", "notes.lnk"}},
		{name: "another file whose owner cannot be checked is left alone", root: trusted,
			entries: map[string]programDataPathSecurity{"helper_status.yaml": unchecked}},
		{name: "folder owner cannot be checked", root: unchecked, wantUnverified: true},
		{name: "agent.yaml owner cannot be checked", root: trusted, entries: map[string]programDataPathSecurity{"agent.yaml": unchecked}, wantUnverified: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			evidence, foreign, err := replaceEvidence(tc.root, tc.entries)
			if tc.wantUnverified {
				if !errors.Is(err, errConfigOwnerUnverified) {
					t.Fatalf("err = %v, want an unverified owner", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (tc.wantEvidence == "") != (evidence == "") || !strings.Contains(evidence, tc.wantEvidence) {
				t.Errorf("evidence = %q, want %q", evidence, tc.wantEvidence)
			}
			if fmt.Sprint(foreign) != fmt.Sprint(tc.wantForeign) && (len(foreign) != 0 || len(tc.wantForeign) != 0) {
				t.Errorf("set aside on their own = %v, want %v", foreign, tc.wantForeign)
			}
		})
	}
}

// fakeRenamer is a directory tree of names only, for the swap tests.
type fakeRenamer struct {
	present   map[string]bool
	onRename  func(from, to string)
	failMoves map[string]error // keyed "from->to"
}

func (f *fakeRenamer) rename(from, to string) error {
	if err, ok := f.failMoves[from+"->"+to]; ok {
		return err
	}
	if !f.present[from] {
		return fmt.Errorf("rename %s: %w", from, os.ErrNotExist)
	}
	if f.present[to] {
		return fmt.Errorf("rename %s %s: %w", from, to, os.ErrExist)
	}
	delete(f.present, from)
	f.present[to] = true
	if f.onRename != nil {
		f.onRename(from, to)
	}
	return nil
}

func (f *fakeRenamer) exists(p string) bool { return f.present[p] }

func swapPaths() (root, staging, aside string) {
	base := filepath.Join(string(filepath.Separator)+"pd", "Breeze")
	return base, base + ".new-1", base + ".untrusted-1"
}

func TestSwapConfigRootIntoPlace(t *testing.T) {
	root, staging, aside := swapPaths()
	fr := &fakeRenamer{present: map[string]bool{root: true, staging: true}}
	keep, err := swapConfigRootIntoPlace(root, staging, aside, fr.rename, fr.exists)
	if err != nil || keep {
		t.Fatalf("keep=%v err=%v", keep, err)
	}
	if !fr.present[root] || !fr.present[aside] || fr.present[staging] {
		t.Errorf("after the swap: %v", fr.present)
	}
}

// TestSwapConfigRootSetsAsideAFolderCreatedDuringTheSwap: any user may
// create a folder in ProgramData, so the config folder's name can be taken
// in the moment between moving the old folder aside and moving the new one
// in. That folder is set aside too and the new folder still goes in.
func TestSwapConfigRootSetsAsideAFolderCreatedDuringTheSwap(t *testing.T) {
	root, staging, aside := swapPaths()
	fr := &fakeRenamer{present: map[string]bool{root: true, staging: true}}
	created := 0
	fr.onRename = func(from, to string) {
		if from == root && created < 2 {
			created++
			fr.present[root] = true // someone took the name again
		}
	}
	keep, err := swapConfigRootIntoPlace(root, staging, aside, fr.rename, fr.exists)
	if err != nil || keep {
		t.Fatalf("keep=%v err=%v", keep, err)
	}
	if fr.present[staging] || !fr.present[root] || !fr.present[aside] {
		t.Errorf("after the swap: %v", fr.present)
	}
	if !fr.present[aside+"-1"] || !fr.present[aside+"-2"] {
		t.Errorf("the folders created at the name were not kept aside: %v", fr.present)
	}
}

// TestSwapConfigRootReportsWhereFoldersAreWhenItCannotFinish: if the new
// folder cannot be moved in and the old one cannot be moved back, the error
// names both locations and the new folder (with the carried config) is kept,
// not deleted.
func TestSwapConfigRootReportsWhereFoldersAreWhenItCannotFinish(t *testing.T) {
	root, staging, aside := swapPaths()
	fr := &fakeRenamer{present: map[string]bool{root: true, staging: true}}
	held := errors.New("in use")
	fr.onRename = func(from, to string) {
		if from == root && to == aside {
			fr.present[root] = true
		}
	}
	fr.failMoves = map[string]error{}
	for i := 1; i <= 5; i++ {
		fr.failMoves[fmt.Sprintf("%s->%s-%d", root, aside, i)] = held
	}
	keep, err := swapConfigRootIntoPlace(root, staging, aside, fr.rename, fr.exists)
	if err == nil {
		t.Fatal("swap reported success")
	}
	if !keep {
		t.Error("the new folder would be deleted although the old one is not back in place")
	}
	for _, p := range []string{aside, staging} {
		if !strings.Contains(err.Error(), p) {
			t.Errorf("error does not say where %s is: %v", p, err)
		}
	}
}

// TestSwapConfigRootPutsTheOldFolderBackWhenTheNewOneCannotGoIn: a failure
// that is not a name collision restores the old folder; the caller may
// remove the new one.
func TestSwapConfigRootPutsTheOldFolderBackWhenTheNewOneCannotGoIn(t *testing.T) {
	root, staging, aside := swapPaths()
	fr := &fakeRenamer{present: map[string]bool{root: true, staging: true},
		failMoves: map[string]error{staging + "->" + root: errors.New("access is denied")}}
	keep, err := swapConfigRootIntoPlace(root, staging, aside, fr.rename, fr.exists)
	if err == nil || keep {
		t.Fatalf("keep=%v err=%v, want an error and the new folder free to remove", keep, err)
	}
	if !fr.present[root] || fr.present[aside] {
		t.Errorf("the old folder was not put back: %v", fr.present)
	}
}

// stubMachineConfigTrust turns the trust check on for files in dir (as it is
// on Windows for the machine config folder) and reads them through read.
func stubMachineConfigTrust(t *testing.T, dir string, read func(path string) ([]byte, error)) *[]string {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)
	t.Cleanup(SetConfigDirForTest(dir))
	var reads []string
	origEnforced, origRead := machineConfigTrustEnforced, readTrustedMachineConfigFileFn
	machineConfigTrustEnforced = func() bool { return true }
	readTrustedMachineConfigFileFn = func(p string) ([]byte, error) {
		reads = append(reads, filepath.Base(p))
		return read(p)
	}
	t.Cleanup(func() { machineConfigTrustEnforced, readTrustedMachineConfigFileFn = origEnforced, origRead })
	return &reads
}

// TestLoadRefusesAnUntrustedMachineConfig: the shared loader refuses the
// machine config when the trust check does, so every process that loads it
// (the agent, the watchdog, the installer steps) fails closed instead of
// running on it.
func TestLoadRefusesAnUntrustedMachineConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent.yaml"), []byte("agent_id: 0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d\nserver_url: https://from-disk.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	refusal := fmt.Errorf("%w: agent.yaml is owned by someone else", ErrConfigDirUntrusted)
	stubMachineConfigTrust(t, dir, func(string) ([]byte, error) { return nil, refusal })

	for _, path := range []string{"", filepath.Join(dir, "agent.yaml")} {
		if cfg, err := Load(path); !errors.Is(err, ErrConfigDirUntrusted) {
			t.Errorf("Load(%q) = %+v, %v; want ErrConfigDirUntrusted", path, cfg, err)
		}
	}
	if _, err := PersistedServerURL(""); !errors.Is(err, ErrConfigDirUntrusted) {
		t.Errorf("PersistedServerURL: err = %v, want ErrConfigDirUntrusted", err)
	}
}

// TestLoadReadsTheMachineConfigThroughTheTrustCheck: what Load uses is what
// the trust check read (from the handle it checked), for agent.yaml and
// secrets.yaml, not a second read by path.
func TestLoadReadsTheMachineConfigThroughTheTrustCheck(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"agent.yaml":   "agent_id: 0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a\nserver_url: https://on-disk.example.com\n",
		"secrets.yaml": "auth_token: brz_on_disk\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	reads := stubMachineConfigTrust(t, dir, func(p string) ([]byte, error) {
		switch filepath.Base(p) {
		case "agent.yaml":
			return []byte("agent_id: c4ec4ed0c4ec4ed0c4ec4ed0c4ec4ed0\nserver_url: https://checked.example.com\n"), nil
		case "secrets.yaml":
			return []byte("auth_token: brz_checked\n"), nil
		}
		return nil, os.ErrNotExist
	})

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentID != "c4ec4ed0c4ec4ed0c4ec4ed0c4ec4ed0" || cfg.AuthToken != "brz_checked" {
		t.Errorf("Load used agent_id %q auth_token %q, want what the trust check read", cfg.AgentID, cfg.AuthToken)
	}
	if fmt.Sprint(*reads) != "[agent.yaml secrets.yaml]" {
		t.Errorf("trust-checked reads = %v", *reads)
	}
	creds, err := ReadPersistedCredentials()
	if err != nil || creds.AuthToken != "brz_checked" {
		t.Errorf("ReadPersistedCredentials = %+v, %v; want the checked secrets", creds, err)
	}
}

// TestLoadOfAMissingMachineConfigIsNotAnError: a fresh host (no agent.yaml)
// still loads defaults, as before.
func TestLoadOfAMissingMachineConfigIsNotAnError(t *testing.T) {
	dir := t.TempDir()
	stubMachineConfigTrust(t, dir, func(p string) ([]byte, error) {
		return nil, fmt.Errorf("%s: %w", p, os.ErrNotExist)
	})
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load on a fresh host: %v", err)
	}
	if cfg.AgentID != "" {
		t.Errorf("agent_id = %q on a fresh host", cfg.AgentID)
	}
}

// TestLoadOutsideTheMachineFolderIsNotTrustChecked: a --config elsewhere is
// the caller's own file and is read as before.
func TestLoadOutsideTheMachineFolderIsNotTrustChecked(t *testing.T) {
	reads := stubMachineConfigTrust(t, t.TempDir(), func(string) ([]byte, error) {
		return nil, fmt.Errorf("%w: should not be asked", ErrConfigDirUntrusted)
	})
	other := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(other, []byte("agent_id: e15e3e3ee15e3e3ee15e3e3ee15e3e3e\nserver_url: https://elsewhere.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(other)
	if err != nil || cfg.AgentID != "e15e3e3ee15e3e3ee15e3e3ee15e3e3e" {
		t.Fatalf("Load(%s) = %+v, %v", other, cfg, err)
	}
	if len(*reads) != 0 {
		t.Errorf("trust-checked reads %v for a file outside the machine folder", *reads)
	}
}

// TestSupportSessionSkipsTheMachineConfigTrustCheck: a support session
// reads only its own private folder, whose files are its user's by design.
func TestSupportSessionSkipsTheMachineConfigTrustCheck(t *testing.T) {
	machine := t.TempDir()
	stubMachineConfigTrust(t, machine, func(string) ([]byte, error) { return nil, nil })
	machineFile := filepath.Join(machine, "agent.yaml")
	if !machineConfigFileNeedsTrust(machineFile) {
		t.Fatal("the machine agent.yaml is not trust-checked")
	}
	if err := SecureUserWorkspace(filepath.Join(t.TempDir(), "breeze-support-1")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(resetUserWorkspaceForTest)
	if machineConfigFileNeedsTrust(machineFile) {
		t.Error("trust check applies while a support workspace is registered")
	}
}
