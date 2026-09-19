package systemstate

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSystemStateManifestJSON(t *testing.T) {
	m := SystemStateManifest{
		Platform:    "darwin",
		OSVersion:   "macOS 15.3",
		Hostname:    "test-host",
		CollectedAt: time.Date(2026, 3, 29, 12, 0, 0, 0, time.UTC),
		Artifacts: []Artifact{
			{
				Name:      "etc_hosts",
				Category:  "config",
				Path:      "hosts/hosts",
				SizeBytes: 1024,
			},
		},
		HardwareProfile: &HardwareProfile{
			CPUModel:      "Apple M2",
			CPUCores:      8,
			TotalMemoryMB: 16384,
			Disks: []DiskInfo{
				{
					Name:      "disk0",
					SizeBytes: 500107862016,
					Model:     "APPLE SSD",
					Partitions: []PartitionInfo{
						{
							Name:       "disk0s1",
							MountPoint: "/",
							FSType:     "apfs",
							SizeBytes:  500107862016,
							UsedBytes:  250000000000,
						},
					},
				},
			},
			NetworkAdapters: []NICInfo{
				{
					Name:       "en0",
					MACAddress: "aa:bb:cc:dd:ee:ff",
					Driver:     "AppleBCM",
				},
			},
			IsUEFI:      true,
			Motherboard: "MacBookPro18,1",
		},
	}

	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded SystemStateManifest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Platform != m.Platform {
		t.Errorf("platform: got %q, want %q", decoded.Platform, m.Platform)
	}
	if decoded.Hostname != m.Hostname {
		t.Errorf("hostname: got %q, want %q", decoded.Hostname, m.Hostname)
	}
	if len(decoded.Artifacts) != 1 {
		t.Fatalf("artifacts: got %d, want 1", len(decoded.Artifacts))
	}
	if decoded.Artifacts[0].Name != "etc_hosts" {
		t.Errorf("artifact name: got %q, want %q", decoded.Artifacts[0].Name, "etc_hosts")
	}
	if decoded.HardwareProfile == nil {
		t.Fatal("hardware profile is nil")
	}
	if decoded.HardwareProfile.CPUCores != 8 {
		t.Errorf("cpu cores: got %d, want 8", decoded.HardwareProfile.CPUCores)
	}
	if !decoded.HardwareProfile.IsUEFI {
		t.Error("isUefi: got false, want true")
	}
	if len(decoded.HardwareProfile.Disks) != 1 {
		t.Fatalf("disks: got %d, want 1", len(decoded.HardwareProfile.Disks))
	}
	if len(decoded.HardwareProfile.Disks[0].Partitions) != 1 {
		t.Fatalf("partitions: got %d, want 1", len(decoded.HardwareProfile.Disks[0].Partitions))
	}
}

func TestManifestOmitEmpty(t *testing.T) {
	// HardwareProfile should be omitted from JSON when nil.
	m := SystemStateManifest{
		Platform:    "linux",
		CollectedAt: time.Now().UTC(),
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	if _, ok := raw["hardwareProfile"]; ok {
		t.Error("hardwareProfile should be omitted when nil")
	}
}

func TestArtifactJSON(t *testing.T) {
	a := Artifact{
		Name:      "registry_SYSTEM",
		Category:  "registry",
		Path:      "registry/SYSTEM",
		SizeBytes: 65536,
	}

	data, err := json.Marshal(a)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Artifact
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Name != a.Name {
		t.Errorf("name: got %q, want %q", decoded.Name, a.Name)
	}
	if decoded.SizeBytes != a.SizeBytes {
		t.Errorf("sizeBytes: got %d, want %d", decoded.SizeBytes, a.SizeBytes)
	}
}

func TestCollectHardwareOnly(t *testing.T) {
	profile, err := CollectHardwareOnly()
	if err != nil {
		t.Fatalf("CollectHardwareOnly: %v", err)
	}
	if profile == nil {
		t.Fatal("profile is nil")
	}

	// On any real machine, we should get a CPU model.
	if profile.CPUModel == "" {
		t.Error("CPU model is empty")
	}
	if profile.CPUCores <= 0 {
		t.Errorf("CPU cores: got %d, want > 0", profile.CPUCores)
	}
	if profile.TotalMemoryMB <= 0 {
		t.Errorf("total memory: got %d MB, want > 0", profile.TotalMemoryMB)
	}
}

func TestCollectSystemState(t *testing.T) {
	// This test runs the real collector on the current platform.
	// Some steps may fail due to permissions, but the overall call should succeed.
	manifest, stagingDir, err := CollectSystemState()
	if err != nil {
		t.Fatalf("CollectSystemState: %v", err)
	}
	defer os.RemoveAll(stagingDir)

	if manifest == nil {
		t.Fatal("manifest is nil")
	}
	if manifest.Platform == "" {
		t.Error("platform is empty")
	}
	if manifest.Hostname == "" {
		t.Error("hostname is empty")
	}
	if manifest.CollectedAt.IsZero() {
		t.Error("collectedAt is zero")
	}
	if stagingDir == "" {
		t.Error("stagingDir is empty")
	}

	// Should have collected at least one artifact on any platform.
	if len(manifest.Artifacts) == 0 {
		t.Error("no artifacts collected")
	}

	// Verify staging directory exists and has files.
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		t.Fatalf("read staging dir: %v", err)
	}
	if len(entries) == 0 {
		t.Error("staging directory is empty")
	}

	t.Logf("collected %d artifacts on %s", len(manifest.Artifacts), manifest.Platform)
	for _, a := range manifest.Artifacts {
		t.Logf("  %s (%s) %d bytes", a.Name, a.Category, a.SizeBytes)
	}
}

func TestNewCollectorImplementsInterface(t *testing.T) {
	var c Collector = NewCollector()
	if c == nil {
		t.Fatal("NewCollector returned nil")
	}
}

func TestHelperArtifactFromFile(t *testing.T) {
	// Create a temp file to test artifactFromFile.
	tmpDir := t.TempDir()
	testFile := tmpDir + "/test.txt"
	if err := os.WriteFile(testFile, []byte("hello"), 0o600); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	a := artifactFromFile("test_file", "test", testFile, tmpDir)
	if a.Name != "test_file" {
		t.Errorf("name: got %q, want %q", a.Name, "test_file")
	}
	if a.Category != "test" {
		t.Errorf("category: got %q, want %q", a.Category, "test")
	}
	if a.SizeBytes != 5 {
		t.Errorf("sizeBytes: got %d, want 5", a.SizeBytes)
	}
	if a.Path != "test.txt" {
		t.Errorf("path: got %q, want %q", a.Path, "test.txt")
	}
	// sha256("hello")
	wantChecksum := "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if a.Checksum != wantChecksum {
		t.Errorf("checksum: got %q, want %q", a.Checksum, wantChecksum)
	}
}

// TestHelperArtifactFromFile_PopulatesMetadata pins the D15 Wave 1 fix
// (finding #6): artifactFromFile must carry mode/uid/gid/modTime, not just
// name/size/checksum — a BMR restore (Wave 3) needs these to put the
// restored file back with its original permissions/ownership/mtime, and the
// only place that metadata is ever recorded is here, at collection time,
// while the source is known-good.
func TestHelperArtifactFromFile_PopulatesMetadata(t *testing.T) {
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello"), 0o640); err != nil {
		t.Fatalf("write test file: %v", err)
	}
	wantModTime := time.Date(2020, 3, 4, 5, 6, 7, 0, time.UTC)
	if err := os.Chtimes(testFile, wantModTime, wantModTime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	a := artifactFromFile("test_file", "test", testFile, tmpDir)

	if a.Mode&0o777 != 0o640 {
		t.Errorf("Mode = %#o, want low 9 bits 0640", a.Mode)
	}
	if !a.ModTime.Equal(wantModTime) {
		t.Errorf("ModTime = %v, want %v", a.ModTime, wantModTime)
	}
	wantUID, wantGID := currentUIDGID(t)
	if wantUID >= 0 && a.UID != wantUID {
		t.Errorf("UID = %d, want %d (current process owner)", a.UID, wantUID)
	}
	if wantGID >= 0 && a.GID != wantGID {
		t.Errorf("GID = %d, want %d (current process group)", a.GID, wantGID)
	}
}

// TestArtifact_JSONRoundTrip proves the new metadata fields (LinkTarget,
// Mode, UID, GID, ModTime) survive a JSON encode/decode cycle unchanged —
// this is the wire format Wave 2's restorer will consume verbatim.
func TestArtifact_JSONRoundTrip(t *testing.T) {
	want := Artifact{
		Name:      "etc_hostname",
		Category:  "config",
		Path:      "etc/hostname",
		SizeBytes: 12,
		Checksum:  "abc123",
		Mode:      0o644,
		UID:       501,
		GID:       20,
		ModTime:   time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC),
	}
	data, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Artifact
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("round-trip mismatch:\n got  %+v\n want %+v", got, want)
	}

	// A symlink artifact (LinkTarget set, no size/checksum) round-trips too.
	link := Artifact{
		Name:       "link_service",
		Category:   "services",
		Path:       "services/wants/x.service",
		LinkTarget: "../x.service",
	}
	linkData, err := json.Marshal(link)
	if err != nil {
		t.Fatalf("marshal link: %v", err)
	}
	var gotLink Artifact
	if err := json.Unmarshal(linkData, &gotLink); err != nil {
		t.Fatalf("unmarshal link: %v", err)
	}
	if !reflect.DeepEqual(link, gotLink) {
		t.Errorf("symlink round-trip mismatch:\n got  %+v\n want %+v", gotLink, link)
	}
}

// TestHelperArtifactFromFile_MissingFileOmitsChecksum proves a hashing
// failure (e.g. the file vanished between stat and hash) degrades to an
// artifact without a checksum rather than panicking or erroring — matching
// the "size 0 / best-effort" tolerance the rest of this helper already has.
func TestHelperArtifactFromFile_MissingFileOmitsChecksum(t *testing.T) {
	tmpDir := t.TempDir()
	missing := filepath.Join(tmpDir, "does-not-exist.txt")

	a := artifactFromFile("missing", "test", missing, tmpDir)
	if a.Checksum != "" {
		t.Errorf("checksum for an unreadable file should be empty, got %q", a.Checksum)
	}
	if a.SizeBytes != 0 {
		t.Errorf("sizeBytes for an unreadable file should be 0, got %d", a.SizeBytes)
	}
}

// TestHelperCollectArtifactsInDir_Checksums proves every artifact walked out
// of a directory carries a checksum too (not just the single-file helper),
// so a BMR consumer can verify EVERY artifact, not a subset.
func TestHelperCollectArtifactsInDir_Checksums(t *testing.T) {
	tmpDir := t.TempDir()
	dir := filepath.Join(tmpDir, "dir")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	artifacts, err := collectArtifactsInDir("test", dir, tmpDir)
	if err != nil {
		t.Fatalf("collectArtifactsInDir: %v", err)
	}
	if len(artifacts) != 1 {
		t.Fatalf("artifacts: got %d, want 1", len(artifacts))
	}
	wantChecksum := "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if artifacts[0].Checksum != wantChecksum {
		t.Errorf("checksum: got %q, want %q", artifacts[0].Checksum, wantChecksum)
	}
}

func TestCollectSystemState_SchemaVersionSet(t *testing.T) {
	manifest, stagingDir, err := CollectSystemState()
	if err != nil {
		t.Fatalf("CollectSystemState: %v", err)
	}
	defer func() { _ = os.RemoveAll(stagingDir) }()

	if manifest.SchemaVersion != manifestSchemaVersion {
		t.Errorf("SchemaVersion = %d, want %d", manifest.SchemaVersion, manifestSchemaVersion)
	}
}

func TestSortedRequiredSteps(t *testing.T) {
	tests := []struct {
		name     string
		required map[string]bool
		want     []string
	}{
		{"nil map", nil, nil},
		{"empty map", map[string]bool{}, nil},
		{
			"mixed required/not-required, sorted output",
			map[string]bool{"boot": true, "registry": true, "certs": false},
			[]string{"boot", "registry"},
		},
		{
			"none required",
			map[string]bool{"certs": false, "iis": false},
			nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sortedRequiredSteps(tt.required)
			if len(got) != len(tt.want) {
				t.Fatalf("sortedRequiredSteps(%v) = %v, want %v", tt.required, got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("sortedRequiredSteps(%v)[%d] = %q, want %q", tt.required, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestHelperCopyFile(t *testing.T) {
	tmpDir := t.TempDir()
	src := tmpDir + "/src.txt"
	dst := tmpDir + "/sub/dst.txt"

	content := []byte("copy test content")
	if err := os.WriteFile(src, content, 0o600); err != nil {
		t.Fatalf("write src: %v", err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("content: got %q, want %q", string(got), string(content))
	}
}

func TestHelperCopyTree(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir() + "/copy"

	// Create a small tree.
	os.MkdirAll(srcDir+"/a/b", 0o700)
	os.WriteFile(srcDir+"/a/file1.txt", []byte("one"), 0o600)
	os.WriteFile(srcDir+"/a/b/file2.txt", []byte("two"), 0o600)

	if err := copyTree(srcDir, dstDir); err != nil {
		t.Fatalf("copyTree: %v", err)
	}

	// Verify files exist in destination.
	for _, rel := range []string{"a/file1.txt", "a/b/file2.txt"} {
		path := dstDir + "/" + rel
		if _, err := os.Stat(path); err != nil {
			t.Errorf("missing file: %s", rel)
		}
	}
}

// TestHelperCopyFile_PreservesModeAndMtime pins the W03-review fix: a staged
// file must keep the SOURCE's permission bits and modification time, not a
// hardcoded 0600/now(). Without this, restoring staged /etc entries back onto
// a live system (the Linux restorer's job) would land every file as
// root:root 0600 regardless of what it was — e.g. /etc/passwd (normally
// 0644) turning unreadable to non-root processes.
func TestHelperCopyFile_PreservesModeAndMtime(t *testing.T) {
	tmpDir := t.TempDir()
	src := filepath.Join(tmpDir, "src.txt")
	dst := filepath.Join(tmpDir, "dst.txt")

	if err := os.WriteFile(src, []byte("mode test"), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	wantMtime := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(src, wantMtime, wantMtime); err != nil {
		t.Fatalf("chtimes src: %v", err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile: %v", err)
	}

	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("stat dst: %v", err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Errorf("dst mode = %v, want 0644 (source's mode)", info.Mode().Perm())
	}
	if !info.ModTime().Equal(wantMtime) {
		t.Errorf("dst mtime = %v, want %v (source's mtime)", info.ModTime(), wantMtime)
	}
}

// TestHelperCopyTree_PreservesDirModeAndMtime is TestHelperCopyFile_
// PreservesModeAndMtime's directory counterpart: a staged directory must
// keep the source directory's mode (e.g. 0750), not a hardcoded 0700.
func TestHelperCopyTree_PreservesDirModeAndMtime(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := filepath.Join(t.TempDir(), "copy")

	subDir := filepath.Join(srcDir, "a")
	if err := os.MkdirAll(subDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "file1.txt"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantMtime := time.Date(2020, 6, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(subDir, wantMtime, wantMtime); err != nil {
		t.Fatalf("chtimes subDir: %v", err)
	}

	if err := copyTree(srcDir, dstDir); err != nil {
		t.Fatalf("copyTree: %v", err)
	}

	info, err := os.Stat(filepath.Join(dstDir, "a"))
	if err != nil {
		t.Fatalf("stat staged dir: %v", err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Errorf("staged dir mode = %v, want 0750 (source's mode)", info.Mode().Perm())
	}
	if !info.ModTime().Equal(wantMtime) {
		t.Errorf("staged dir mtime = %v, want %v (source's mtime)", info.ModTime(), wantMtime)
	}
}

// TestHelperCopyTree_NestedRestrictiveDirFixupOrder proves a 0500 (r-x,
// write-denied but still traversable) parent directory's fixup never blocks
// a deeper child's own chmod/lchown fixup — i.e. dir fixups are applied in
// an order that lets every descendant still be reached and fixed up, however
// restrictive an ancestor's SOURCE mode is. copyTree stages directories at a
// permissive 0700 DURING the walk specifically so writing children never
// fails; this test is the other half — the fixup PASS afterward must not
// re-lock a parent down before its child's own fixup has run.
func TestHelperCopyTree_NestedRestrictiveDirFixupOrder(t *testing.T) {
	srcDir := t.TempDir()
	parent := filepath.Join(srcDir, "parent")
	child := filepath.Join(parent, "child")
	if err := os.MkdirAll(child, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, "file.txt"), []byte("nested"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Set restrictive/looser modes AFTER writing content, since MkdirAll with
	// 0o500 partway through would block creating file.txt itself.
	if err := os.Chmod(child, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	// Restore write permission before t.TempDir()'s own cleanup tries to
	// RemoveAll srcDir — otherwise deleting "child" out of a 0500 "parent"
	// fails. Registered after the chmod above so it runs first (LIFO).
	t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })

	dstDir := filepath.Join(t.TempDir(), "copy")
	stagedParent := filepath.Join(dstDir, "parent")
	// Same reasoning as srcDir's cleanup above: copyTree replicates the
	// restrictive mode onto the STAGED parent too, which would otherwise
	// block this test's own dstDir tempdir cleanup.
	t.Cleanup(func() { _ = os.Chmod(stagedParent, 0o700) })

	if err := copyTree(srcDir, dstDir); err != nil {
		t.Fatalf("copyTree: %v", err)
	}

	stagedChild := filepath.Join(stagedParent, "child")
	stagedFile := filepath.Join(stagedChild, "file.txt")

	if _, err := os.Stat(stagedFile); err != nil {
		t.Fatalf("nested file under a restrictive parent was not staged: %v", err)
	}
	parentInfo, err := os.Stat(stagedParent)
	if err != nil {
		t.Fatalf("stat staged parent: %v", err)
	}
	if parentInfo.Mode().Perm() != 0o500 {
		t.Errorf("staged parent mode = %v, want 0500 (source's mode)", parentInfo.Mode().Perm())
	}
	childInfo, err := os.Stat(stagedChild)
	if err != nil {
		t.Fatalf("stat staged child: %v", err)
	}
	if childInfo.Mode().Perm() != 0o700 {
		t.Errorf("staged child mode = %v, want 0700 (source's mode) — restrictive parent fixup must not have blocked this", childInfo.Mode().Perm())
	}
}

// TestHelperCopyFile_RecreatesSymlink proves a symlink is staged as a real
// symlink (Lstat + Readlink + Symlink), not dereferenced into a plain-file
// copy of whatever it currently points at — including a DANGLING link, which
// must stage successfully rather than erroring.
func TestHelperCopyFile_RecreatesSymlink(t *testing.T) {
	tmpDir := t.TempDir()

	target := filepath.Join(tmpDir, "target.txt")
	if err := os.WriteFile(target, []byte("target contents"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(tmpDir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	dangling := filepath.Join(tmpDir, "dangling")
	if err := os.Symlink(filepath.Join(tmpDir, "does-not-exist"), dangling); err != nil {
		t.Fatal(err)
	}

	dstLink := filepath.Join(tmpDir, "staged", "link")
	if err := copyFile(link, dstLink); err != nil {
		t.Fatalf("copyFile(symlink): %v", err)
	}
	gotTarget, err := os.Readlink(dstLink)
	if err != nil {
		t.Fatalf("staged entry is not a symlink: %v", err)
	}
	if gotTarget != target {
		t.Errorf("staged symlink target = %q, want %q", gotTarget, target)
	}

	dstDangling := filepath.Join(tmpDir, "staged", "dangling")
	if err := copyFile(dangling, dstDangling); err != nil {
		t.Fatalf("copyFile(dangling symlink) should succeed, got: %v", err)
	}
	gotDanglingTarget, err := os.Readlink(dstDangling)
	if err != nil {
		t.Fatalf("staged dangling entry is not a symlink: %v", err)
	}
	if gotDanglingTarget != filepath.Join(tmpDir, "does-not-exist") {
		t.Errorf("staged dangling symlink target = %q, want %q", gotDanglingTarget, filepath.Join(tmpDir, "does-not-exist"))
	}
}

// TestHelperCopyTree_RecreatesSymlinksAndSkipsSpecialFiles exercises the
// whole-tree walk: a symlink inside the tree is staged as a symlink, and a
// Unix socket (a stand-in for any of socket/FIFO/device) is skipped rather
// than staged or erroring the whole walk.
func TestHelperCopyTree_RecreatesSymlinksAndSkipsSpecialFiles(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := filepath.Join(t.TempDir(), "copy")

	if err := os.WriteFile(filepath.Join(srcDir, "real.txt"), []byte("real"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.txt", filepath.Join(srcDir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	// AF_UNIX socket paths are capped at ~104-108 bytes on macOS/BSD — well
	// under what t.TempDir()'s nesting can produce — so this uses its own
	// short-named temp dir rather than srcDir/t.TempDir() directly.
	sockDir, sockDirErr := os.MkdirTemp("", "bzss")
	if sockDirErr != nil {
		t.Fatalf("create short-path temp dir for socket: %v", sockDirErr)
	}
	defer func() { _ = os.RemoveAll(sockDir) }()
	sockPath := filepath.Join(sockDir, "s")
	ln, sockErr := net.Listen("unix", sockPath)
	if sockErr != nil {
		t.Skipf("cannot create a unix socket in this sandbox, skipping: %v", sockErr)
	}
	defer func() { _ = ln.Close() }()
	if err := os.Rename(sockPath, filepath.Join(srcDir, "test.sock")); err != nil {
		t.Fatalf("move socket into srcDir: %v", err)
	}

	if err := copyTree(srcDir, dstDir); err != nil {
		t.Fatalf("copyTree: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dstDir, "real.txt")); err != nil {
		t.Errorf("regular file was not staged: %v", err)
	}
	linkTarget, err := os.Readlink(filepath.Join(dstDir, "link.txt"))
	if err != nil {
		t.Fatalf("symlink was not staged as a symlink: %v", err)
	}
	if linkTarget != "real.txt" {
		t.Errorf("staged symlink target = %q, want %q", linkTarget, "real.txt")
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "test.sock")); err == nil {
		t.Error("unix socket should have been skipped, not staged")
	}
}

// TestHelperCollectArtifactsInDir_SymlinksEnumeratedWithLinkTarget pins the
// D15 Wave 1 fix (finding #5): a staged symlink is now enumerated as its own
// Artifact — LinkTarget set to the link's target, SizeBytes 0, no checksum —
// rather than excluded outright. Only enumerated artifacts get published
// (see publishSystemState), so excluding symlinks silently lost every one of
// them (e.g. /etc/systemd/system/*.wants/*.service).
func TestHelperCollectArtifactsInDir_SymlinksEnumeratedWithLinkTarget(t *testing.T) {
	tmpDir := t.TempDir()
	dir := filepath.Join(tmpDir, "dir")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "real.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.txt", filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	artifacts, err := collectArtifactsInDir("test", dir, tmpDir)
	if err != nil {
		t.Fatalf("collectArtifactsInDir: %v", err)
	}
	if len(artifacts) != 2 {
		t.Fatalf("artifacts = %d, want 2 (real file + symlink), got %+v", len(artifacts), artifacts)
	}
	var symlinkArtifact, regularArtifact *Artifact
	for i := range artifacts {
		switch artifacts[i].Name {
		case "link.txt":
			symlinkArtifact = &artifacts[i]
		case "real.txt":
			regularArtifact = &artifacts[i]
		}
	}
	if regularArtifact == nil {
		t.Fatal("real.txt artifact missing")
	}
	if regularArtifact.Checksum == "" {
		t.Error("regular file artifact should still carry a checksum")
	}
	if symlinkArtifact == nil {
		t.Fatal("link.txt symlink artifact missing")
	}
	if symlinkArtifact.LinkTarget != "real.txt" {
		t.Errorf("symlink LinkTarget = %q, want %q", symlinkArtifact.LinkTarget, "real.txt")
	}
	if symlinkArtifact.SizeBytes != 0 {
		t.Errorf("symlink SizeBytes = %d, want 0", symlinkArtifact.SizeBytes)
	}
	if symlinkArtifact.Checksum != "" {
		t.Errorf("symlink Checksum = %q, want empty (no independent file content)", symlinkArtifact.Checksum)
	}
}

func TestMissingRequired(t *testing.T) {
	required := map[string]bool{"registry": true, "boot": true}
	tests := []struct {
		name       string
		incomplete []string
		want       []string
	}{
		{"nothing incomplete", nil, nil},
		{"only optional failed", []string{"certs", "iis"}, nil},
		{"one required failed", []string{"registry"}, []string{"registry"}},
		{"required + optional failed", []string{"iis", "boot", "certs"}, []string{"boot"}},
		{"both required failed", []string{"registry", "boot"}, []string{"registry", "boot"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := missingRequired(tt.incomplete, required)
			if len(got) != len(tt.want) {
				t.Fatalf("missingRequired(%v) = %v, want %v", tt.incomplete, got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("missingRequired[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Registry hive collection (collectRegistryHives) and CertSvc detection
// (certSvcInstalled) — the platform-independent seams behind the Windows
// registry/certs steps (state_windows.go). Both are package-level vars/funcs
// defined in helpers.go specifically so this logic is exercisable here, on
// any GOOS, without a real Windows machine or reg.exe/certutil.exe. See O12
// and O13 in docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md.
// ---------------------------------------------------------------------------

func TestCollectRegistryHivesPartialFailure(t *testing.T) {
	orig := runRegSave
	defer func() { runRegSave = orig }()

	runRegSave = func(hive, outPath string) ([]byte, error) {
		if hive == "SECURITY" {
			return []byte("access is denied"), fmt.Errorf("exit status 5")
		}
		if err := os.WriteFile(outPath, []byte("hive-"+hive), 0o600); err != nil {
			return nil, err
		}
		return []byte("ok"), nil
	}

	dir := t.TempDir()
	artifacts, err := collectRegistryHives(dir, dir, []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"})

	if err == nil {
		t.Fatal("collectRegistryHives: expected error, got nil")
	}
	var rsErr *registrySaveError
	if !errors.As(err, &rsErr) {
		t.Fatalf("collectRegistryHives: error type = %T, want *registrySaveError", err)
	}
	if want := []string{"SECURITY"}; !reflect.DeepEqual(rsErr.FailedHives, want) {
		t.Errorf("FailedHives = %v, want %v", rsErr.FailedHives, want)
	}
	if !strings.Contains(err.Error(), "SECURITY") {
		t.Errorf("error %q does not name SECURITY", err.Error())
	}
	if len(artifacts) != 3 {
		t.Errorf("artifacts = %d, want 3 (hives that succeeded are kept despite the failure)", len(artifacts))
	}
}

func TestCollectRegistryHivesAllSucceed(t *testing.T) {
	orig := runRegSave
	defer func() { runRegSave = orig }()

	runRegSave = func(hive, outPath string) ([]byte, error) {
		if err := os.WriteFile(outPath, []byte("hive-"+hive), 0o600); err != nil {
			return nil, err
		}
		return []byte("ok"), nil
	}

	dir := t.TempDir()
	hives := []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"}
	artifacts, err := collectRegistryHives(dir, dir, hives)
	if err != nil {
		t.Fatalf("collectRegistryHives: unexpected error: %v", err)
	}
	if len(artifacts) != len(hives) {
		t.Errorf("artifacts = %d, want %d", len(artifacts), len(hives))
	}
}

func TestCollectRegistryHivesAllFail(t *testing.T) {
	orig := runRegSave
	defer func() { runRegSave = orig }()

	runRegSave = func(hive, outPath string) ([]byte, error) {
		return []byte("boom"), fmt.Errorf("exit status 1")
	}

	dir := t.TempDir()
	hives := []string{"SYSTEM", "SOFTWARE"}
	artifacts, err := collectRegistryHives(dir, dir, hives)
	if err == nil {
		t.Fatal("collectRegistryHives: expected error when every hive fails, got nil")
	}
	if len(artifacts) != 0 {
		t.Errorf("artifacts = %d, want 0", len(artifacts))
	}
	var rsErr *registrySaveError
	if !errors.As(err, &rsErr) || !reflect.DeepEqual(rsErr.FailedHives, hives) {
		t.Errorf("FailedHives = %v, want %v", rsErr, hives)
	}
}

func TestCertSvcInstalledChecksCertsrvExe(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("WINDIR", tmp)

	if certSvcInstalled() {
		t.Error("certSvcInstalled() = true before certsrv.exe exists, want false")
	}

	sys32 := filepath.Join(tmp, "system32")
	if err := os.MkdirAll(sys32, 0o700); err != nil {
		t.Fatalf("mkdir system32: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sys32, "certsrv.exe"), []byte("x"), 0o755); err != nil {
		t.Fatalf("write certsrv.exe: %v", err)
	}

	if !certSvcInstalled() {
		t.Error("certSvcInstalled() = false after certsrv.exe created, want true")
	}
}
