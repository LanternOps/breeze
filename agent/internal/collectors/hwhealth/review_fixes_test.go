package hwhealth

import (
	"context"
	"strings"
	"testing"
	"time"
)

// An adapter whose BBU block has neither a state nor an explicit "not present" must not
// let the MegaCli source claim completeness, even when another adapter's BBU parsed.
func TestMegaCLIUnrecognizedBBUBlockIsIncomplete(t *testing.T) {
	s := newMegaCLI(nil)
	outputs := fixtureOutputs(t, "megacli/optimal.txt", s.commands)
	outputs[3].text += "\nBBU status for Adapter: 1\nBBU Type: future supercap\n"
	if s.parse(outputs).Complete {
		t.Fatal("unobserved adapter-1 battery reported as a complete observation")
	}
	outputs = fixtureOutputs(t, "megacli/optimal.txt", s.commands)
	outputs[2].text = replaceOnce(t, outputs[2].text, "Predictive Failure Count: 0", "Predictive Failure Count: 0\nMedia Error Count: N/A")
	pd := w02bComponent(t, s.parse(outputs), "megacli:c0:e252:s3")
	if _, ok := pd.Attributes["mediaErrors"]; ok {
		t.Fatalf("fabricated mediaErrors: %+v", pd.Attributes)
	}
}

func replaceOnce(t *testing.T, s, old, new string) string {
	t.Helper()
	if !strings.Contains(s, old) {
		t.Fatalf("fixture lacks %q", old)
	}
	return strings.Replace(s, old, new, 1)
}

type blockingDetect struct{ selectionStub }

func (b blockingDetect) Detect(ctx context.Context) Availability {
	<-ctx.Done()
	return Availability{}
}

// When the cycle budget expires during detection, undetected sources get the sentinel
// Available:true. That sentinel must not make an uninstalled storcli supersede perccli.
func TestCollectorBudgetExpiryDoesNotFabricatePrecedence(t *testing.T) {
	col := New(Options{DataDir: t.TempDir(), Sources: []Source{
		selectionStub{"perccli", true, nil},
		blockingDetect{selectionStub{"slow", true, nil}},
		selectionStub{"storcli", false, nil},
	}})
	col.budget = 20 * time.Millisecond
	snap, err := col.Run(context.Background(), []Tier{"raid"})
	if err != nil || snap == nil {
		t.Fatalf("snap=%v err=%v", snap, err)
	}
	for _, r := range snap.Sources {
		if r.Source == "perccli" && r.Status == "superseded" {
			t.Fatalf("budget sentinel superseded perccli: %+v", r)
		}
	}
}
