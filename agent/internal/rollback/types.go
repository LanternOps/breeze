package rollback

import (
	"context"
	"time"
)

type Component string

type ComponentVersion struct {
	Current string `json:"current"`
	Target  string `json:"target"`
}

type Artifact struct {
	Component      Component `json:"component"`
	CurrentVersion string    `json:"currentVersion"`
	TargetVersion  string    `json:"targetVersion"`
	DownloadURL    string    `json:"downloadUrl"`
	SHA256         string    `json:"sha256"`
	Size           int64     `json:"size"`
}

type Directive struct {
	SchemaVersion         int                         `json:"schemaVersion"`
	RollbackID            string                      `json:"rollbackId"`
	DeviceID              string                      `json:"deviceId"`
	OrgID                 string                      `json:"orgId"`
	Platform              string                      `json:"platform"`
	Architecture          string                      `json:"architecture"`
	CurrentVersion        string                      `json:"currentVersion"`
	TargetVersion         string                      `json:"targetVersion"`
	ComponentVersions     map[string]ComponentVersion `json:"componentVersions"`
	ReleaseManifest       string                      `json:"releaseManifest"`
	ManifestSignature     string                      `json:"manifestSignature"`
	ManifestSigningKeyID  string                      `json:"manifestSigningKeyId"`
	Artifacts             []Artifact                  `json:"artifacts"`
	Reason                string                      `json:"reason"`
	AuthorizedBy          string                      `json:"authorizedBy"`
	ApprovedAt            string                      `json:"approvedAt"`
	ExpiresAt             string                      `json:"expiresAt"`
	DirectiveSigningKeyID string                      `json:"directiveSigningKeyId"`
	DirectiveSignature    string                      `json:"directiveSignature"`
}

type Phase string

const (
	PhaseReceived         Phase = "received"
	PhaseDownloaded       Phase = "downloaded"
	PhaseVerified         Phase = "verified"
	PhaseStaged           Phase = "staged"
	PhaseSwapped          Phase = "swapped"
	PhaseRestartRequested Phase = "restart_requested"
	PhaseHealthy          Phase = "healthy"
	PhaseFailed           Phase = "failed"
	PhaseRecovered        Phase = "recovered"
)

type Observation struct {
	SchemaVersion     int               `json:"schemaVersion"`
	ObservationID     string            `json:"observationId"`
	RollbackID        string            `json:"rollbackId"`
	DeviceID          string            `json:"deviceId"`
	Phase             Phase             `json:"phase"`
	CurrentVersion    string            `json:"currentVersion"`
	ComponentVersions map[string]string `json:"componentVersions"`
	ObservedAt        time.Time         `json:"observedAt"`
	ErrorCode         string            `json:"errorCode,omitempty"`
}

type Backend interface {
	Prepare(context.Context, Directive) error
	Swap(context.Context, Directive) error
	Restart(context.Context, Directive) error
	Healthy(context.Context, Directive) (bool, error)
	Finalize(context.Context, Directive) error
	Recover(context.Context, Directive) error
}

type Environment struct {
	DeviceID        string
	OrgID           string
	Platform        string
	Architecture    string
	CurrentVersion  string
	Now             func() time.Time
	VerifySignature func(keyID string, payload, signature []byte) error
	Backend         Backend
}
