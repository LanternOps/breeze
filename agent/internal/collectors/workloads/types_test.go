package workloads

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func ptr[T any](v T) *T { return &v }

// The server rejects unknown keys, so these golden strings are the wire
// contract. Update them only together with the API's workloadsReportSchema.
const goldenMinimal = `{"protocolVersion":1,"collectedAt":"2026-10-06T12:00:00Z","runtimes":[{"runtime":"docker","detection":"absent","collection":"unavailable","complete":true,"runtimeVersion":null,"observedCount":0,"error":null,"workloads":[]}]}`

const goldenFull = `{"protocolVersion":1,"collectedAt":"2026-10-06T12:00:00Z","runtimes":[{"runtime":"docker","detection":"present","collection":"ok","complete":true,"runtimeVersion":"27.1.1","observedCount":1,"error":null,"workloads":[{"workloadId":"abc","kind":"container","name":"web","state":"running","rawState":"running","imageRef":"nginx:1.27","imageRepository":"docker.io/library/nginx","imageTag":"1.27","imageDigest":"sha256:d1","imageId":"sha256:a0","guestOs":null,"composeProject":"shop","composeService":"web","composeWorkingDir":"/srv/shop","restartPolicy":null,"cpuCount":null,"memoryMb":null,"startedAt":null,"runtimeCreatedAt":"2026-10-01T08:30:00Z"}]}]}`

func TestReportGoldenMinimal(t *testing.T) {
	r := Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []RuntimeReport{{
		Runtime: RuntimeDocker, Detection: DetectionAbsent, Collection: CollectionUnavailable,
		Complete: true, Workloads: []Workload{},
	}}}
	got, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != goldenMinimal {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, goldenMinimal)
	}
}

func TestReportGoldenFull(t *testing.T) {
	w := Workload{
		WorkloadID: "abc", Kind: KindContainer, Name: "web", State: StateRunning,
		RawState: ptr("running"), ImageRef: ptr("nginx:1.27"),
		ImageRepository: ptr("docker.io/library/nginx"), ImageTag: ptr("1.27"),
		ImageDigest: ptr("sha256:d1"), ImageID: ptr("sha256:a0"),
		ComposeProject: ptr("shop"), ComposeService: ptr("web"), ComposeWorkingDir: ptr("/srv/shop"),
		RuntimeCreatedAt: ptr("2026-10-01T08:30:00Z"),
	}
	r := Report{ProtocolVersion: 1, CollectedAt: "2026-10-06T12:00:00Z", Runtimes: []RuntimeReport{{
		Runtime: RuntimeDocker, Detection: DetectionPresent, Collection: CollectionOK,
		Complete: true, RuntimeVersion: ptr("27.1.1"), ObservedCount: 1, Workloads: []Workload{w},
	}}}
	got, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != goldenFull {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, goldenFull)
	}
}

// Every wire key is always present: a missing key is not the same as null to a
// strict nullable zod field, and an extra key is a 400 for the whole report.
func TestWorkloadEmitsExactlyTheContractKeys(t *testing.T) {
	want := []string{"workloadId", "kind", "name", "state", "rawState", "imageRef", "imageRepository",
		"imageTag", "imageDigest", "imageId", "guestOs", "composeProject", "composeService",
		"composeWorkingDir", "restartPolicy", "cpuCount", "memoryMb", "startedAt", "runtimeCreatedAt"}
	raw, _ := json.Marshal(Workload{})
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	var got []string
	for k := range m {
		got = append(got, k)
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
}

func TestSettingsRuntimeEnabled(t *testing.T) {
	s := DefaultSettings()
	if s.RuntimeEnabled(RuntimeDocker) {
		t.Fatal("default settings must not enumerate anything")
	}
	s.Enabled = true
	if !s.RuntimeEnabled(RuntimeDocker) || !s.RuntimeEnabled(RuntimePodman) {
		t.Fatal("enabled settings should enumerate docker and podman")
	}
	s.Podman = false
	if s.RuntimeEnabled(RuntimePodman) {
		t.Fatal("podman switch ignored")
	}
	if !s.RuntimeEnabled(RuntimeContainerd) {
		t.Fatal("containerd follows the master switch")
	}
	s.Enabled = false
	if s.RuntimeEnabled(RuntimeContainerd) {
		t.Fatal("master switch off must disable every runtime")
	}
}

func TestBoundClipsOnRuneBoundaryAndDropsEmpty(t *testing.T) {
	long := strings.Repeat("é", 400) // 800 bytes
	w := Workload{WorkloadID: strings.Repeat("a", 300), Name: long, ImageRef: ptr(long), RawState: ptr("")}
	w.Bound()
	if len(w.WorkloadID) != 128 {
		t.Fatalf("workloadId len = %d", len(w.WorkloadID))
	}
	if len(w.Name) > 255 || !strings.HasSuffix(w.Name, "é") {
		t.Fatalf("name not clipped on a rune boundary: len=%d", len(w.Name))
	}
	if w.ImageRef == nil || len(*w.ImageRef) > 512 {
		t.Fatal("imageRef not bounded")
	}
	if w.RawState != nil {
		t.Fatal("empty string must become null")
	}
}
