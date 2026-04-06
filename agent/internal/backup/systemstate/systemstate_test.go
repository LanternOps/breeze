package systemstate

import (
	"encoding/json"
	"os"
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
