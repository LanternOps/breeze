package agentapp

import (
	"encoding/json"

	"github.com/breeze-rmm/agent/pkg/api"
)

// deployKeyRefusal is the guidance for one deploy-key enrollment refusal.
type deployKeyRefusal struct {
	cat      enrollErrCategory
	friendly string
}

// deployKeyRefusals maps the `reason` a deploy-key (`bdk_`) enrollment is
// refused with (#8318 wave D-1, routes/agents/enrollmentDeployKey.ts) to
// guidance that fits it. A deploy key is an image key: it is baked into an
// OS image, parks the device in the partner's holding area, and is managed by
// a partner administrator in the holding area's image-key settings, not in
// an organization's Settings → Enrollment, which is where the generic
// 401/403 message sends the user (correct for org keys, the
// `enrollment_key_*` reasons, which keep it).
//
// Categories keep the exit codes stable: key refusals stay catAuth (the
// status they arrive with, 401/403), the rate bucket stays catRateLimit
// (429), and the holding-area caps (409) are "retry later" refusals, so they
// share catRateLimit's exit code instead of falling to catUnknown.
var deployKeyRefusals = map[string]deployKeyRefusal{
	"deploy_key_not_found": {catAuth, "image deploy key not recognized — the server has no deploy key matching the one this image was built with. " +
		"Deploy keys are managed by a partner administrator in the holding area's image-key settings; get the image's current key and rebuild the image (or re-run enrollment) with it"},
	"deploy_key_revoked": {catAuth, "this image's deploy key has been revoked — a partner administrator must issue a new image key in the holding area's image-key settings, " +
		"and the image must be rebuilt (or enrollment re-run) with the new key"},
	"deploy_key_expired": {catAuth, "this image's deploy key has expired — a partner administrator must issue a new image key in the holding area's image-key settings, " +
		"and the image must be rebuilt (or enrollment re-run) with the new key"},
	"deploy_key_exhausted": {catAuth, "this image's deploy key has reached its maximum number of enrollments — a partner administrator must rotate the image key in the holding area's image-key settings, " +
		"and the image must be updated with the new key"},
	"deploy_key_source_not_allowed": {catAuth, "this image's deploy key only accepts enrollments from the partner's approved networks, and this device is enrolling from another one — " +
		"enroll from an allowed network, or ask a partner administrator to update the key's allowed source networks"},
	"deploy_key_rate_limited": {catRateLimit, "too many devices enrolled with this image's deploy key in the last few minutes — wait about 10 minutes and retry"},
	"deploy_key_enrollment_unavailable": {catAuth, "enrollment with image deploy keys is not available for this partner right now (switched off, or the partner is not eligible) — " +
		"a partner administrator must check the holding-area settings"},
	"deploy_key_parked_cap_reached": {catRateLimit, "this image's deploy key already has its maximum number of devices waiting for assignment — " +
		"a partner administrator must assign or remove waiting devices in the holding area, then retry"},
	"parked_cap_reached": {catRateLimit, "the partner's holding area is full — a partner administrator must assign or remove waiting devices, then retry"},
}

// classifyDeployKeyRefusal reports the guidance for a deploy-key refusal
// named by httpErr's JSON `reason`, or ok=false for any other body.
func classifyDeployKeyRefusal(httpErr *api.ErrHTTPStatus) (enrollErrCategory, string, bool) {
	var body struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal([]byte(httpErr.Body), &body) != nil {
		return 0, "", false
	}
	refusal, ok := deployKeyRefusals[body.Reason]
	if !ok {
		return 0, "", false
	}
	return refusal.cat, refusal.friendly, true
}
