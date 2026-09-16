// Package networkdiagnostic runs only authenticated, bounded, explicit plans.
package networkdiagnostic

import (
	"context"
	"net/netip"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

type Scope struct {
	OrgID  string `json:"orgId"`
	SiteID string `json:"siteId"`
}
type Subject struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type Origin struct {
	DeviceID       string  `json:"deviceId"`
	AgentID        string  `json:"agentId"`
	NodeID         string  `json:"nodeId"`
	BindingID      string  `json:"bindingId"`
	SiteID         string  `json:"siteId"`
	ContextKey     string  `json:"contextKey"`
	InterfaceID    *string `json:"interfaceId"`
	InterfaceEpoch *string `json:"interfaceEpoch"`
	InterfaceKey   *string `json:"interfaceKey"`
	SourceID       string  `json:"sourceId"`
	ProducerEpoch  string  `json:"producerEpoch"`
	Sequence       string  `json:"sequence"`
}
type TargetDefinition struct {
	Kind              string   `json:"kind"`
	Label             string   `json:"label"`
	Enabled           bool     `json:"enabled"`
	Families          []string `json:"families"`
	Provider          *string  `json:"provider"`
	IndependenceLabel *string  `json:"independenceLabel"`
	Hostname          string   `json:"hostname,omitempty"`
	Host              string   `json:"host,omitempty"`
	Port              uint16   `json:"port,omitempty"`
	ExpectedAddresses []string `json:"expectedAddresses,omitempty"`
	Resolver          string   `json:"resolver,omitempty"`
	Path              string   `json:"path,omitempty"`
	Method            string   `json:"method,omitempty"`
	ExpectedStatus    int      `json:"expectedStatus,omitempty"`
	MaxRedirects      int      `json:"maxRedirects,omitempty"`
	ProxyMode         string   `json:"proxyMode,omitempty"`
}
type Target struct {
	Kind           string            `json:"kind"`
	Address        string            `json:"address,omitempty"`
	Zone           *string           `json:"zone,omitempty"`
	InterfaceID    string            `json:"interfaceId,omitempty"`
	EvidenceID     string            `json:"evidenceId,omitempty"`
	Port           uint16            `json:"port,omitempty"`
	LocalStub      bool              `json:"localStub,omitempty"`
	TargetID       string            `json:"targetId,omitempty"`
	TargetRevision string            `json:"targetRevision,omitempty"`
	Definition     *TargetDefinition `json:"definition,omitempty"`
}
type Destination struct {
	ID     string `json:"id"`
	Target Target `json:"target"`
}
type PlanStep struct {
	ID                     string   `json:"id"`
	Required               bool     `json:"required"`
	DestinationID          *string  `json:"destinationId"`
	Method                 string   `json:"method"`
	PacketCount            int      `json:"packetCount,omitempty"`
	TimeoutMS              int      `json:"timeoutMs,omitempty"`
	PayloadBytes           int      `json:"payloadBytes,omitempty"`
	Retries                int      `json:"retries,omitempty"`
	QueryType              string   `json:"queryType,omitempty"`
	ResolverDestinationIDs []string `json:"resolverDestinationIds,omitempty"`
	ResponseLimitBytes     int      `json:"responseLimitBytes,omitempty"`
}
type Limits struct {
	MaxConcurrentSteps      int `json:"maxConcurrentSteps"`
	MaxTargetAddresses      int `json:"maxTargetAddresses"`
	MaxResolvers            int `json:"maxResolvers"`
	QueueTimeoutSeconds     int `json:"queueTimeoutSeconds"`
	ExecutionTimeoutSeconds int `json:"executionTimeoutSeconds"`
	LifetimeSeconds         int `json:"lifetimeSeconds"`
}
type TemplateVersions struct {
	Partner  *string `json:"partner"`
	Org      *string `json:"org"`
	Defaults int     `json:"defaults"`
	Resolver int     `json:"resolver"`
}
type Plan struct {
	Version          int              `json:"version"`
	RecipeID         string           `json:"recipeId"`
	RecipeVersion    int              `json:"recipeVersion"`
	Scope            Scope            `json:"scope"`
	Subject          Subject          `json:"subject"`
	Origin           Origin           `json:"origin"`
	Family           string           `json:"family"`
	GraphRevision    string           `json:"graphRevision"`
	SettingsRevision string           `json:"settingsRevision"`
	ContextRevision  string           `json:"contextRevision"`
	TemplateVersions TemplateVersions `json:"templateVersions"`
	Destinations     []Destination    `json:"destinations"`
	Steps            []PlanStep       `json:"steps"`
	Limits           Limits           `json:"limits"`
	AcceptedAt       time.Time        `json:"acceptedAt"`
	QueueDeadline    time.Time        `json:"queueDeadline"`
	Deadline         time.Time        `json:"deadline"`
	Digest           string           `json:"digest"`
	Reasons          []string         `json:"reasons"`
}
type Command struct {
	rawPlan    []byte
	Type       string    `json:"type"`
	Version    int       `json:"version"`
	RunID      string    `json:"runId"`
	AttemptID  string    `json:"attemptId"`
	CommandID  string    `json:"commandId"`
	Plan       Plan      `json:"plan"`
	PlanDigest string    `json:"planDigest"`
	ExpiresAt  time.Time `json:"expiresAt"`
}
type Attribution struct {
	OriginDeviceID  string   `json:"originDeviceId"`
	OriginAgentID   string   `json:"originAgentId"`
	RequestedMethod string   `json:"requestedMethod"`
	ActualMethod    *string  `json:"actualMethod"`
	DestinationID   *string  `json:"destinationId"`
	ResolvedIP      *string  `json:"resolvedIp"`
	Family          *string  `json:"family"`
	Port            *uint16  `json:"port"`
	InterfaceID     *string  `json:"interfaceId"`
	LocalAddress    *string  `json:"localAddress"`
	ContextKey      *string  `json:"contextKey"`
	TableKey        *string  `json:"tableKey"`
	NextHop         *string  `json:"nextHop"`
	ProxyUsed       *bool    `json:"proxyUsed"`
	Quality         string   `json:"quality"`
	RouteChanged    bool     `json:"routeChanged"`
	EvidenceRefs    []string `json:"evidenceRefs"`
}
type Details struct {
	LatencyMS         *float64 `json:"latencyMs,omitempty"`
	PacketsSent       *int     `json:"packetsSent,omitempty"`
	PacketsReceived   *int     `json:"packetsReceived,omitempty"`
	StatusCode        *int     `json:"statusCode,omitempty"`
	ResolvedAddresses []string `json:"resolvedAddresses,omitempty"`
	ErrorCode         string   `json:"errorCode,omitempty"`
}
type StepResult struct {
	ID          string      `json:"id"`
	State       string      `json:"state"`
	Reason      *string     `json:"reason"`
	Attribution Attribution `json:"attribution"`
	StartedAt   *time.Time  `json:"startedAt"`
	FinishedAt  *time.Time  `json:"finishedAt"`
	ReceivedAt  *time.Time  `json:"receivedAt"`
	Truncated   bool        `json:"truncated"`
	Details     Details     `json:"details"`
}
type Result struct {
	Version    int          `json:"version"`
	RunID      string       `json:"runId"`
	AttemptID  string       `json:"attemptId"`
	CommandID  string       `json:"commandId"`
	PlanDigest string       `json:"planDigest"`
	Steps      []StepResult `json:"steps"`
	Truncated  bool         `json:"truncated"`
}
type StepKey struct {
	CommandID string `json:"commandId"`
	RunID     string `json:"runId"`
	AttemptID string `json:"attemptId"`
	StepID    string `json:"stepId"`
}

func (k StepKey) String() string {
	return k.RunID + ":" + k.AttemptID + ":" + k.StepID
}
func (c Command) StepKey(stepID string) StepKey {
	return StepKey{c.CommandID, c.RunID, c.AttemptID, stepID}
}

// ProbeIO receives only validated literal addresses. The hostname is retained
// separately for TLS verification; implementations must never resolve it again.
type ProbeIO interface {
	LookupRoute(context.Context, networkcontext.RouteLookupRequest) (networkcontext.RouteSelection, error)
	Resolvers(context.Context) ([]networkcontext.ResolverRow, error)
	Resolve(context.Context, string, string, []networkcontext.ResolverRow, networkcontext.RouteSelection, int) ([]netip.Addr, error)
	ICMP(context.Context, netip.Addr, networkcontext.RouteSelection, int, int) (Details, error)
	TCP(context.Context, netip.Addr, uint16, networkcontext.RouteSelection) (Details, error)
	HTTPS(context.Context, netip.Addr, TargetDefinition, networkcontext.RouteSelection, string, int) (Details, error)
}

func ptr[T any](v T) *T { return &v }
