package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"golang.org/x/time/rate"
)

// Commander queues commands for simulated devices through the admin API, so
// the agents' command-result path carries load. Its requests are not agent
// traffic and are never recorded in the route mix.
type Commander struct {
	ServerURL string
	Cfg       CommanderConfig
	Client    *http.Client
	Rec       *Recorder
	DeviceIDs func() []string
}

func (c *Commander) Run(ctx context.Context) error {
	token, err := c.login(ctx)
	if err != nil {
		return err
	}
	lim := rate.NewLimiter(rate.Limit(c.Cfg.PerMinute/60), 1)
	next := 0
	for {
		if err := lim.Wait(ctx); err != nil {
			return nil // run over
		}
		ids := c.DeviceIDs()
		if len(ids) == 0 {
			continue
		}
		deviceID := ids[next%len(ids)]
		next++
		status, err := c.dispatch(ctx, token, deviceID)
		if err == nil && status == http.StatusUnauthorized { // access token expired
			if token, err = c.login(ctx); err != nil {
				return err
			}
			status, err = c.dispatch(ctx, token, deviceID)
		}
		c.Rec.CommandDispatched(err == nil && status == http.StatusCreated)
	}
}

// login signs in as the lab admin. A login with no auth-binding cookie is
// answered 428 auth_binding_rotation_required with a Set-Cookie; the client
// (which must carry a cookie jar) retries once and the second attempt succeeds.
func (c *Commander) login(ctx context.Context) (string, error) {
	body, _ := json.Marshal(map[string]string{"email": c.Cfg.Email, "password": c.Cfg.Password})
	var (
		status int
		data   []byte
	)
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ServerURL+"/api/v1/auth/login", bytes.NewReader(body))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.Client.Do(req)
		if err != nil {
			return "", fmt.Errorf("commander login: %w", err)
		}
		data, _ = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		status = resp.StatusCode
		if status != http.StatusPreconditionRequired {
			break
		}
	}
	var out struct {
		Tokens *struct {
			AccessToken string `json:"accessToken"`
		} `json:"tokens"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &out) != nil || out.Tokens == nil || out.Tokens.AccessToken == "" {
		return "", fmt.Errorf("commander login: HTTP %d with no access token (the lab stack pins MFA_FORCE_FOR_PARTNER_ADMIN=false; check --admin-email/--admin-password)", status)
	}
	return out.Tokens.AccessToken, nil
}

func (c *Commander) dispatch(ctx context.Context, token, deviceID string) (int, error) {
	body, _ := json.Marshal(map[string]string{"type": c.Cfg.CommandType})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ServerURL+"/api/v1/devices/"+deviceID+"/commands", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Client.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}
