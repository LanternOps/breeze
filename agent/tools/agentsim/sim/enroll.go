package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/pkg/api"
)

// ErrEnrollRejected is a terminal (non-429) enrollment refusal.
var ErrEnrollRejected = errors.New("enrollment rejected")

// Enroller enrolls simulated devices the way `breeze-agent enroll` does.
type Enroller struct {
	ServerURL    string
	Key          string
	Secret       string
	AgentVersion string
	OSType       string
	Client       *http.Client
	MaxAttempts  int                                             // default 5
	Sleep        func(ctx context.Context, d time.Duration) bool // default sleepCtx
}

func (e *Enroller) Enroll(ctx context.Context, index int, hostname string) (Identity, error) {
	body, err := json.Marshal(api.EnrollRequest{
		EnrollmentKey:    e.Key,
		EnrollmentSecret: e.Secret,
		Hostname:         hostname,
		OSType:           e.OSType,
		OSVersion:        osVersion(e.OSType),
		Architecture:     "amd64",
		AgentVersion:     e.AgentVersion,
		HardwareInfo: &api.HardwareInfo{
			CPUModel: "agentsim vCPU", CPUCores: 4, CPUThreads: 8, RAMTotalMB: 16384, DiskTotalGB: 500,
			SerialNumber: "AGENTSIM-" + hostname, Manufacturer: "Breeze", Model: "agentsim",
		},
	})
	if err != nil {
		return Identity{}, err
	}
	attempts := e.MaxAttempts
	if attempts <= 0 {
		attempts = 5
	}
	sleep := e.Sleep
	if sleep == nil {
		sleep = sleepCtx
	}
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(withLogicalRequest(ctx), http.MethodPost,
			e.ServerURL+"/api/v1/agents/enroll", bytes.NewReader(body))
		if err != nil {
			return Identity{}, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := e.Client.Do(req)
		if err != nil {
			if attempt >= attempts || !sleep(ctx, time.Second) {
				return Identity{}, fmt.Errorf("enroll %s: %w", hostname, err)
			}
			continue
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated:
			var out api.EnrollResponse
			if err := json.Unmarshal(data, &out); err != nil {
				return Identity{}, fmt.Errorf("enroll %s: decode response: %w", hostname, err)
			}
			if out.AgentID == "" || !strings.HasPrefix(out.AuthToken, "brz_") {
				return Identity{}, fmt.Errorf("enroll %s: response has no agentId or brz_ token", hostname)
			}
			return Identity{Index: index, Hostname: hostname, AgentID: out.AgentID, DeviceID: out.DeviceID,
				AuthToken: out.AuthToken, OrgID: out.OrgID, SiteID: out.SiteID, EnrolledAt: time.Now().UTC()}, nil
		case resp.StatusCode == http.StatusTooManyRequests && attempt < attempts:
			wait := httputil.ParseRetryAfter(resp.Header, time.Now())
			if wait <= 0 {
				wait = time.Second
			}
			if !sleep(ctx, wait) {
				return Identity{}, ctx.Err()
			}
		default:
			msg := string(data)
			if len(msg) > 300 {
				msg = msg[:300]
			}
			return Identity{}, fmt.Errorf("%w: %s: HTTP %d: %s", ErrEnrollRejected, hostname, resp.StatusCode, msg)
		}
	}
}
