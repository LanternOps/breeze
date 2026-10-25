package agentapp

import (
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// #8318 §6.6 "Crash during the local swap": start-up finishes a confirmed
// reattach before anything reads the identity, and starts on the reloaded
// config.
func TestFinishConfirmedRebindAtStartup(t *testing.T) {
	origFinish, origReload := finishConfirmedRebindFn, reloadConfigAfterRebindFn
	t.Cleanup(func() { finishConfirmedRebindFn, reloadConfigAfterRebindFn = origFinish, origReload })

	start := &config.Config{AgentID: "source", IsService: true, IsHeadless: true, IsInstalledAgent: true}
	reloaded := &config.Config{AgentID: "target", DeviceID: "00000000-0000-4000-8000-000000000004"}

	cases := []struct {
		name       string
		changed    bool
		finishErr  error
		reloadErr  error
		wantAgent  string
		wantErr    bool
		wantReload bool
	}{
		{name: "nothing to finish", wantAgent: "source"},
		{name: "finished", changed: true, wantAgent: "target", wantReload: true},
		{name: "could not finish: the heartbeat retries", finishErr: errors.New("disk"), wantAgent: "source"},
		{name: "finished but the staged file stayed", changed: true, finishErr: errors.New("remove"), wantAgent: "target", wantReload: true},
		{name: "finished but the reload failed", changed: true, reloadErr: errors.New("parse"), wantErr: true, wantReload: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reloads := 0
			finishConfirmedRebindFn = func(string) (bool, error) { return tc.changed, tc.finishErr }
			reloadConfigAfterRebindFn = func(string) (*config.Config, error) {
				reloads++
				if tc.reloadErr != nil {
					return nil, tc.reloadErr
				}
				c := *reloaded
				return &c, nil
			}
			got, err := finishConfirmedRebindAtStartup(start)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if (reloads == 1) != tc.wantReload {
				t.Fatalf("reloads = %d, want reload %v", reloads, tc.wantReload)
			}
			if tc.wantErr {
				return
			}
			if got.AgentID != tc.wantAgent {
				t.Fatalf("agent = %s, want %s", got.AgentID, tc.wantAgent)
			}
			if !got.IsService || !got.IsHeadless || !got.IsInstalledAgent {
				t.Fatal("runtime flags were lost on reload")
			}
		})
	}
}
