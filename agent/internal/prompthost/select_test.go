package prompthost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type skewRow struct {
	Name               string    `json:"name"`
	Kind               string    `json:"kind"`
	Renderer           string    `json:"renderer"`
	AgentSpeaks        []string  `json:"agentSpeaks"`
	RendererAdvertises *[]string `json:"rendererAdvertises"`
	Enabled            []string  `json:"enabled"`
	ExpectedPath       string    `json:"expectedPath"`
	ExpectedVersion    int       `json:"expectedVersion"`
}

// TestSelectFollowsSkewMatrix runs the shared spec §8 matrix (the same rows
// the TS reference negotiator passes) through the Go selector.
func TestSelectFollowsSkewMatrix(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(fixtureDir, "skew-matrix.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []skewRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 15 {
		t.Fatalf("matrix has %d rows", len(rows))
	}
	for _, row := range rows {
		t.Run(row.Name, func(t *testing.T) {
			var agent []int
			for _, ad := range row.AgentSpeaks {
				if name, v, ok := ipc.ParsePromptKindAd(ad); ok && name == row.Kind {
					agent = append(agent, v)
				}
			}
			r := RendererSession{Key: "r-1", Owner: testOwner, Role: ipc.HelperRoleAssist}
			if row.Renderer == "native" {
				r.Role = ipc.HelperRoleUser
			}
			if row.RendererAdvertises != nil {
				r.Protocol = 1
				r.KindAds = *row.RendererAdvertises
			}
			choice := selectRenderer(row.Kind, agent, []RendererSession{r}, parseEnabledKinds(row.Enabled), nil, true, false)
			want := PathLegacy
			if row.ExpectedPath == "prompt" {
				want = PathPrompt
			}
			if choice.Path != want {
				t.Fatalf("path = %v, want %v", choice.Path, want)
			}
			if want == PathPrompt && (choice.Version != row.ExpectedVersion || choice.Renderer.Key != "r-1") {
				t.Fatalf("version = %d renderer = %q, want %d r-1", choice.Version, choice.Renderer.Key, row.ExpectedVersion)
			}
		})
	}
}

func TestSelectExactlyOneRendererWithOldNativeAndNewAssist(t *testing.T) {
	oldNative := RendererSession{Key: "user-old", Role: ipc.HelperRoleUser, Owner: testOwner} // advertised nothing
	newAssist := assistRenderer("assist-new", "restart.prompt@1")

	choice := selectRenderer("restart.prompt", []int{1}, []RendererSession{oldNative, newAssist}, parseEnabledKinds([]string{"restart.prompt"}), nil, true, false)
	if choice.Path != PathPrompt || choice.Renderer.Key != "assist-new" {
		t.Fatalf("choice = %+v, want the new Assist", choice)
	}

	hh := newHarness(t, oldNative, newAssist)
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:1", t0.Add(3600e9), calls))
	msgs := hh.dir.take()
	if len(msgs) != 1 || msgs[0].Key != "assist-new" {
		t.Fatalf("messages = %+v, want exactly one prompt_show to the new Assist", msgs)
	}
	if n, _, _ := calls.counts(); n != 0 {
		t.Fatal("the old native helper must not also get the legacy type")
	}

	// New Assist that does not speak the kind: the legacy path, exactly once.
	silentAssist := assistRenderer("assist-w02") // protocol 1, zero kinds (the W02 build)
	lh := newHarness(t, oldNative, silentAssist)
	lc := &promptCalls{}
	_ = lh.h.Show(restartPrompt(t, "restart:2", t0.Add(3600e9), lc))
	if msgs := lh.dir.take(); len(msgs) != 0 {
		t.Fatalf("prompt_* sent to a renderer that did not advertise the kind: %+v", msgs)
	}
	if n, _, _ := lc.counts(); n != 1 {
		t.Fatalf("legacy calls = %d, want 1", n)
	}

	// Two prompt-capable renderers: Assist wins over the native helper.
	newNative := nativeRenderer("user-new", "restart.prompt@1")
	both := selectRenderer("restart.prompt", []int{1}, []RendererSession{newNative, newAssist}, parseEnabledKinds([]string{"restart.prompt"}), nil, true, false)
	if both.Renderer.Key != "assist-new" {
		t.Fatalf("choice = %+v, want Assist first", both)
	}
}

func TestSelectRoleRules(t *testing.T) {
	enabled := parseEnabledKinds([]string{"elevation.request"})
	system := RendererSession{Key: "sys-1", Role: ipc.HelperRoleSystem, Owner: testOwner, Protocol: 1, KindAds: []string{"elevation.request@1"}}
	user := nativeRenderer("user-1", "elevation.request@1")
	if c := selectRenderer("elevation.request", []int{1}, []RendererSession{user, system}, enabled, nil, true, false); c.Renderer.Key != "sys-1" {
		t.Fatalf("elevation native renderer = %+v, want the SYSTEM helper", c)
	}
	noticeOnSystem := RendererSession{Key: "sys-1", Role: ipc.HelperRoleSystem, Owner: testOwner, Protocol: 1, KindAds: []string{"notice.info@1"}}
	if c := selectRenderer("notice.info", []int{1}, []RendererSession{noticeOnSystem}, parseEnabledKinds([]string{"notice.info"}), nil, true, false); c.Path != PathLegacy {
		t.Fatalf("the SYSTEM helper drew a non-elevation kind: %+v", c)
	}
}

func TestSelectFallbackOrder(t *testing.T) {
	none := parseEnabledKinds(nil)
	if c := selectRenderer("notice.info", []int{1}, nil, none, nil, false, true); c.Path != PathHeadless {
		t.Fatalf("no legacy sender, headless available: %v", c.Path)
	}
	if c := selectRenderer("notice.info", []int{1}, nil, none, nil, false, false); c.Path != PathNone {
		t.Fatalf("nothing available: %v", c.Path)
	}
	excluded := selectRenderer("notice.info", []int{1}, []RendererSession{assistRenderer("a", "notice.info@1")}, parseEnabledKinds([]string{"notice.info"}), map[string]bool{"a": true}, true, false)
	if excluded.Path != PathLegacy {
		t.Fatalf("an excluded renderer was chosen: %+v", excluded)
	}
}

func TestParseEnabledKinds(t *testing.T) {
	e := parseEnabledKinds([]string{"notice.info", "restart.prompt@2", "bogus", "remote.consent@01", "future.kind"})
	cases := []struct {
		kind string
		v    int
		want bool
	}{
		{"notice.info", 1, true},
		{"notice.info", 7, true},
		{"restart.prompt", 2, true},
		{"restart.prompt", 1, false},
		{"remote.consent", 1, false},
		{"future.kind", 1, false},
	}
	for _, tc := range cases {
		if got := e.allows(tc.kind, tc.v); got != tc.want {
			t.Errorf("allows(%s, %d) = %v, want %v", tc.kind, tc.v, got, tc.want)
		}
	}
}
