package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

func rollbackAssetName(component string) string {
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	return "breeze-" + component + "-" + runtime.GOOS + "-" + runtime.GOARCH + suffix
}

func signedRollbackStageRequest(t *testing.T, serverURL string, content map[RollbackComponent][]byte) RollbackStageRequest {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, publicKey)

	manifest := releaseArtifactManifest{SchemaVersion: 1, Release: "v1.9.0"}
	request := RollbackStageRequest{
		DirectiveID: "11111111-1111-4111-8111-111111111111",
		Platform:    manifestPlatform(), Architecture: runtime.GOARCH,
		CurrentVersion: "2.0.0", TargetVersion: "1.9.0",
		ComponentVersions:    map[RollbackComponent]RollbackComponentVersion{},
		ManifestSigningKeyID: testEmbeddedKeyID,
	}
	for _, component := range []RollbackComponent{RollbackComponentAgent, RollbackComponentBackup} {
		bytes := content[component]
		sum := sha256.Sum256(bytes)
		checksum := hex.EncodeToString(sum[:])
		manifest.Assets = append(manifest.Assets, releaseArtifactAsset{
			Name: rollbackAssetName(string(component)), SHA256: checksum, Size: int64(len(bytes)),
		})
		request.ComponentVersions[component] = RollbackComponentVersion{Current: "2.0.0", Target: "1.9.0"}
		request.Artifacts = append(request.Artifacts, RollbackArtifactMetadata{
			Component: component, CurrentVersion: "2.0.0", TargetVersion: "1.9.0",
			DownloadURL: serverURL + "/" + string(component), SHA256: checksum, Size: int64(len(bytes)),
		})
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	request.ReleaseManifest = string(payload)
	request.ManifestSignature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return request
}

func TestStageRollbackArtifacts_VerifiesCompleteDirectiveBoundSet(t *testing.T) {
	content := map[RollbackComponent][]byte{
		RollbackComponentAgent: []byte("target agent"), RollbackComponentBackup: []byte("target backup"),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		component := RollbackComponent(strings.TrimPrefix(r.URL.Path, "/"))
		if bytes, ok := content[component]; ok {
			_, _ = w.Write(bytes)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	u := New(&Config{ServerURL: staticServerURL(server.URL), AuthToken: secmem.NewSecureString("token")})
	u.client = server.Client()
	request := signedRollbackStageRequest(t, server.URL, content)
	staged, err := u.StageRollbackArtifacts(request)
	if err != nil {
		t.Fatalf("StageRollbackArtifacts: %v", err)
	}
	defer staged.Cleanup()
	if len(staged.Artifacts) != 2 {
		t.Fatalf("staged artifacts = %d, want 2", len(staged.Artifacts))
	}
	for _, artifact := range staged.Artifacts {
		got, err := os.ReadFile(artifact.StagedPath)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(content[artifact.Component]) {
			t.Fatalf("%s bytes were not verified and staged", artifact.Component)
		}
	}
}

func TestStageRollbackArtifacts_RejectsDirectiveAndArtifactMismatches(t *testing.T) {
	content := map[RollbackComponent][]byte{
		RollbackComponentAgent: []byte("target agent"), RollbackComponentBackup: []byte("target backup"),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content[RollbackComponent(strings.TrimPrefix(r.URL.Path, "/"))])
	}))
	defer server.Close()

	tests := map[string]func(*RollbackStageRequest){
		"platform":       func(r *RollbackStageRequest) { r.Platform = "wrong" },
		"architecture":   func(r *RollbackStageRequest) { r.Architecture = "wrong" },
		"target version": func(r *RollbackStageRequest) { r.TargetVersion = "1.8.0" },
		"component target": func(r *RollbackStageRequest) {
			r.ComponentVersions[RollbackComponentAgent] = RollbackComponentVersion{Current: "2.0.0", Target: "1.8.0"}
		},
		"artifact current":  func(r *RollbackStageRequest) { r.Artifacts[0].CurrentVersion = "2.0.1" },
		"artifact checksum": func(r *RollbackStageRequest) { r.Artifacts[0].SHA256 = strings.Repeat("a", 64) },
		"artifact size":     func(r *RollbackStageRequest) { r.Artifacts[0].Size++ },
		"URL policy":        func(r *RollbackStageRequest) { r.Artifacts[0].DownloadURL = "file:///tmp/rollback-artifact" },
		"manifest signature": func(r *RollbackStageRequest) {
			r.ManifestSignature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
		},
		"manifest key id":     func(r *RollbackStageRequest) { r.ManifestSigningKeyID = "unknown-key" },
		"duplicate component": func(r *RollbackStageRequest) { r.Artifacts = append(r.Artifacts, r.Artifacts[0]) },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			u := New(&Config{ServerURL: staticServerURL(server.URL), AuthToken: secmem.NewSecureString("token")})
			u.client = server.Client()
			request := signedRollbackStageRequest(t, server.URL, content)
			mutate(&request)
			if staged, err := u.StageRollbackArtifacts(request); err == nil {
				staged.Cleanup()
				t.Fatal("mismatched rollback metadata must fail closed")
			}
		})
	}
}

func TestStageRollbackArtifacts_FailureLeavesLiveSetUntouched(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"agent", "backup"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("old "+name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	content := map[RollbackComponent][]byte{RollbackComponentAgent: []byte("target agent"), RollbackComponentBackup: []byte("target backup")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/backup" {
			_, _ = w.Write([]byte("corrupt backup"))
			return
		}
		_, _ = w.Write(content[RollbackComponentAgent])
	}))
	defer server.Close()
	u := New(&Config{ServerURL: staticServerURL(server.URL), AuthToken: secmem.NewSecureString("token")})
	u.client = server.Client()
	request := signedRollbackStageRequest(t, server.URL, content)
	if staged, err := u.StageRollbackArtifacts(request); err == nil {
		staged.Cleanup()
		t.Fatal("corrupt second artifact must fail the whole staging operation")
	}
	for _, name := range []string{"agent", "backup"} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != "old "+name {
			t.Fatalf("live %s changed during staging", name)
		}
	}
}

func TestRollbackSwapJournalRecoversEveryInterruptedBoundary(t *testing.T) {
	for failAfter := 0; failAfter < 2; failAfter++ {
		t.Run(string(rune('1'+failAfter)), func(t *testing.T) {
			dir := t.TempDir()
			set := RollbackSwapSet{DirectiveID: "rollback-id", JournalPath: filepath.Join(dir, "rollback.json")}
			for _, name := range []string{"agent", "backup"} {
				live := filepath.Join(dir, name)
				staged := filepath.Join(dir, name+".staged")
				if err := os.WriteFile(live, []byte("old "+name), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(staged, []byte("target "+name), 0o755); err != nil {
					t.Fatal(err)
				}
				set.Artifacts = append(set.Artifacts, RollbackSwapArtifact{Component: RollbackComponent(name), StagedPath: staged, LivePath: live})
			}
			err := swapRollbackArtifacts(set, func(index int) error {
				if index == failAfter {
					return errors.New("injected interruption")
				}
				return nil
			})
			if err == nil {
				t.Fatal("expected injected interruption")
			}
			if _, err := os.Stat(set.JournalPath); err != nil {
				t.Fatalf("recoverable journal missing: %v", err)
			}
			if err := RecoverRollbackSwap(set.JournalPath); err != nil {
				t.Fatalf("recover: %v", err)
			}
			for _, name := range []string{"agent", "backup"} {
				got, err := os.ReadFile(filepath.Join(dir, name))
				if err != nil {
					t.Fatal(err)
				}
				if string(got) != "old "+name {
					t.Fatalf("%s = %q after recovery", name, got)
				}
			}
		})
	}
}

func TestRollbackSwapCommitsCompleteTargetSet(t *testing.T) {
	dir := t.TempDir()
	set := RollbackSwapSet{DirectiveID: "rollback-id", JournalPath: filepath.Join(dir, "rollback.json")}
	for _, name := range []string{"agent", "backup"} {
		live := filepath.Join(dir, name)
		staged := filepath.Join(dir, name+".staged")
		if err := os.WriteFile(live, []byte("old "+name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(staged, []byte("target "+name), 0o755); err != nil {
			t.Fatal(err)
		}
		set.Artifacts = append(set.Artifacts, RollbackSwapArtifact{Component: RollbackComponent(name), StagedPath: staged, LivePath: live})
	}
	if err := SwapRollbackArtifacts(set); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"agent", "backup"} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != "target "+name {
			t.Fatalf("%s = %q after commit", name, got)
		}
	}
	if _, err := os.Stat(set.JournalPath); !os.IsNotExist(err) {
		t.Fatalf("journal retained after commit: %v", err)
	}
}

func TestRollbackSwapRetainsOldSetUntilHealthCommit(t *testing.T) {
	newSet := func(t *testing.T) RollbackSwapSet {
		dir := t.TempDir()
		set := RollbackSwapSet{DirectiveID: "rollback-id", JournalPath: filepath.Join(dir, "rollback.json")}
		for _, name := range []string{"agent", "backup"} {
			live := filepath.Join(dir, name)
			staged := filepath.Join(dir, name+".staged")
			if err := os.WriteFile(live, []byte("old "+name), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(staged, []byte("target "+name), 0o755); err != nil {
				t.Fatal(err)
			}
			set.Artifacts = append(set.Artifacts, RollbackSwapArtifact{Component: RollbackComponent(name), StagedPath: staged, LivePath: live})
		}
		return set
	}
	t.Run("unhealthy recovers old", func(t *testing.T) {
		set := newSet(t)
		if err := SwapRollbackArtifactsRetainingJournal(set); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(set.JournalPath); err != nil {
			t.Fatal("recoverable journal was not retained")
		}
		if err := RecoverRollbackSwap(set.JournalPath); err != nil {
			t.Fatal(err)
		}
		for _, artifact := range set.Artifacts {
			got, _ := os.ReadFile(artifact.LivePath)
			if string(got) != "old "+string(artifact.Component) {
				t.Fatalf("%s was not recovered", artifact.Component)
			}
		}
	})
	t.Run("healthy commits target", func(t *testing.T) {
		set := newSet(t)
		if err := SwapRollbackArtifactsRetainingJournal(set); err != nil {
			t.Fatal(err)
		}
		if err := CommitRollbackSwap(set.JournalPath); err != nil {
			t.Fatal(err)
		}
		for _, artifact := range set.Artifacts {
			got, _ := os.ReadFile(artifact.LivePath)
			if string(got) != "target "+string(artifact.Component) {
				t.Fatalf("%s target was not retained", artifact.Component)
			}
		}
		if _, err := os.Stat(set.JournalPath); !os.IsNotExist(err) {
			t.Fatal("committed journal was not removed")
		}
	})
}

func TestPrepareRollbackArtifactsLeavesLiveSetUntouched(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "agent")
	staged := filepath.Join(dir, "agent.staged")
	journalPath := filepath.Join(dir, "rollback.json")
	if err := os.WriteFile(live, []byte("old agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged, []byte("target agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	journal, err := prepareRollbackArtifacts(RollbackSwapSet{
		DirectiveID: "rollback-id",
		JournalPath: journalPath,
		Artifacts:   []RollbackSwapArtifact{{Component: RollbackComponentAgent, StagedPath: staged, LivePath: live}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if journal.State != "prepared" {
		t.Fatalf("journal state = %q, want prepared", journal.State)
	}
	got, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "old agent" {
		t.Fatalf("prepare mutated running executable: %q", got)
	}
	if _, err := os.Stat(journal.Artifacts[0].NewPath); err != nil {
		t.Fatalf("detached target copy missing: %v", err)
	}
	if err := recoverRollbackSwapInline(journalPath); err != nil {
		t.Fatal(err)
	}
}
