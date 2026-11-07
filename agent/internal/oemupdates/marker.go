package oemupdates

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"time"
)

const markerFile = "run.json"

// Run stages, also sent as command_progress stages.
const (
	StageStarting       = "starting"
	StageVerifying      = "verifying"
	StageInstallingTool = "installing_tool"
	StageInstalling     = "installing"
	StageReporting      = "reporting"
)

// Marker is the durable record of the current or last run. It is written before
// anything runs and ended when the result is known, so a run the agent did not
// finish is visible after a restart, and a firmware install is verified after
// the reboot it needs (suspend → update → reboot → verify).
type Marker struct {
	CommandID    string     `json:"commandId"`
	Lane         string     `json:"lane"`
	Trigger      string     `json:"trigger"`
	StartedAt    time.Time  `json:"startedAt"`
	Stage        string     `json:"stage"`
	ToolVersion  string     `json:"toolVersion,omitempty"`
	FlashStarted bool       `json:"flashStarted"`
	EndedAt      *time.Time `json:"endedAt,omitempty"`
	Outcome      Outcome    `json:"outcome,omitempty"`
	// RebootRequired and ShutdownRequired are the ended run's, kept so a
	// result lost before hand-off still asks for the reboot it needs.
	RebootRequired   bool `json:"rebootRequired,omitempty"`
	ShutdownRequired bool `json:"shutdownRequired,omitempty"`
}

// LostResult is reported for a run that ended but whose result never left
// the agent: the recorded outcome stands, and errorCode says the detail was
// lost. ok is false when the marker has no usable outcome.
func (m Marker) LostResult() (RunResult, bool) {
	if m.EndedAt == nil || !containsOutcome(m.Outcome) {
		return RunResult{}, false
	}
	r := RunResult{
		Lane: m.Lane, Outcome: m.Outcome, ErrorCode: strPtr("result_lost_after_run"),
		RebootRequired: m.RebootRequired, ShutdownRequired: m.ShutdownRequired, Takeover: TakeoverNotAttempted,
	}
	if m.ToolVersion != "" {
		v := sanitizeToolText(m.ToolVersion, maxVersionLen)
		r.ToolVersion = &v
	}
	return r, r.Validate() == nil
}

// WriteMarker records m durably.
func WriteMarker(store Store, m Marker) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return store.WriteFile(markerFile, data)
}

// ReadMarker returns the marker, fs.ErrNotExist when there is none, and an error
// for one that cannot be read.
func ReadMarker(store Store) (Marker, error) {
	data, err := store.ReadFile(markerFile)
	if err != nil {
		return Marker{}, err
	}
	var m Marker
	if err := json.Unmarshal(data, &m); err != nil {
		return Marker{}, fmt.Errorf("run marker is corrupt: %w", err)
	}
	if m.CommandID == "" || !IsLane(m.Lane) {
		return Marker{}, errors.New("run marker names no command or lane")
	}
	return m, nil
}

// ReadInterruptedMarker returns a marker for a run that started and never ended.
// A corrupt marker names no command, so it is not reported as one; it is logged.
func ReadInterruptedMarker(store Store) (Marker, bool) {
	m, err := ReadMarker(store)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Warn("vendor update run marker unreadable", "error", err.Error())
		}
		return Marker{}, false
	}
	if m.EndedAt != nil {
		return Marker{}, false
	}
	return m, true
}

// InterruptedResult is the result reported for a run the agent stopped during.
// Whatever the marker knows is kept; the stage names where it stopped.
func (m Marker) InterruptedResult() RunResult {
	r := RunResult{
		Lane:      m.Lane,
		Outcome:   OutcomeInterrupted,
		ErrorCode: strPtr("agent_restarted_during_" + stageCode(m.Stage)),
		Takeover:  TakeoverNotAttempted,
	}
	if m.ToolVersion != "" {
		v := sanitizeToolText(m.ToolVersion, maxVersionLen)
		r.ToolVersion = &v
	}
	return r
}

func stageCode(stage string) string {
	switch stage {
	case StageStarting, StageVerifying, StageInstallingTool, StageInstalling, StageReporting:
		return stage
	}
	return "run"
}
