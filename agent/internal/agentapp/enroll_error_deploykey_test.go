package agentapp

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/pkg/api"
)

// #8318 D-1a: deploy-key refusals get guidance that fits an image key, never
// the org-key "Settings → Enrollment" text; org-key reasons keep it.
func TestClassifyEnrollError_DeployKeyReasons(t *testing.T) {
	tests := []struct {
		reason  string
		status  int
		wantCat enrollErrCategory
		want    string // a substring the guidance must carry
	}{
		{"deploy_key_not_found", 401, catAuth, "image-key settings"},
		{"deploy_key_revoked", 401, catAuth, "new image key"},
		{"deploy_key_expired", 401, catAuth, "new image key"},
		{"deploy_key_exhausted", 401, catAuth, "rotate the image key"},
		{"deploy_key_source_not_allowed", 403, catAuth, "network"},
		{"deploy_key_rate_limited", 429, catRateLimit, "retry"},
		{"deploy_key_enrollment_unavailable", 403, catAuth, "holding-area settings"},
		{"deploy_key_parked_cap_reached", 409, catRateLimit, "waiting for assignment"},
		{"parked_cap_reached", 409, catRateLimit, "holding area is full"},
	}
	for _, tt := range tests {
		t.Run(tt.reason, func(t *testing.T) {
			err := &api.ErrHTTPStatus{StatusCode: tt.status, Body: `{"error":"x","reason":"` + tt.reason + `"}`}
			cat, friendly := classifyEnrollError(err, "https://example.com")
			if cat != tt.wantCat {
				t.Errorf("category = %v, want %v", cat, tt.wantCat)
			}
			if !strings.Contains(friendly, tt.want) {
				t.Errorf("friendly = %q, want it to mention %q", friendly, tt.want)
			}
			if strings.Contains(friendly, "Settings → Enrollment") {
				t.Errorf("friendly = %q points a deploy-key refusal at the org-key settings", friendly)
			}
		})
	}
}

func TestClassifyEnrollError_OrgKeyReasonsUnchanged(t *testing.T) {
	const orgKeyMsg = "enrollment key not recognized — verify the key is active in Settings → Enrollment on the server"
	for _, reason := range []string{"enrollment_key_not_found", "enrollment_key_expired", "enrollment_key_exhausted", ""} {
		body := `{"error":"x"}`
		if reason != "" {
			body = `{"error":"x","reason":"` + reason + `"}`
		}
		cat, friendly := classifyEnrollError(&api.ErrHTTPStatus{StatusCode: 401, Body: body}, "https://example.com")
		if cat != catAuth || friendly != orgKeyMsg {
			t.Errorf("reason %q: got (%v, %q), want (catAuth, the org-key message)", reason, cat, friendly)
		}
	}
}
