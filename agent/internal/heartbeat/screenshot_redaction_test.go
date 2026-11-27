package heartbeat

import (
	"encoding/base64"
	"encoding/json"
	"image"
	"math/rand"
	"regexp"
	"testing"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// awsKeyInText is SanitizeOutput's AWS rule: unanchored and case-insensitive,
// so it fires by chance inside long base64 text.
var awsKeyInText = regexp.MustCompile(`(?i)AKIA[0-9A-Z]{16}`)

// noiseImageWithAWSShapedBase64 returns a deterministic noise image whose
// JPEG encoding (as the screenshot encoder produces it) has base64 text that
// matches the AWS-key rule, together with that base64 text.
func noiseImageWithAWSShapedBase64(t *testing.T) (*image.RGBA, string) {
	t.Helper()
	const w, h = 320, 240
	for seed := int64(1); seed <= 2000; seed++ {
		rng := rand.New(rand.NewSource(seed))
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		rng.Read(img.Pix)
		data, err := desktop.EncodeJPEG(img, 85)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		b64 := base64.StdEncoding.EncodeToString(data)
		if awsKeyInText.MatchString(b64) {
			return img, b64
		}
	}
	t.Fatal("no seed produced AWS-shaped base64; widen the search")
	return nil, ""
}

// #12795: the agent never runs the text redaction patterns over a screenshot
// result. take_screenshot and computer_action results go from the encoder to
// the wire untouched (only script output passes through SanitizeOutput), so an
// image whose base64 happens to match a secret pattern must come back
// byte-identical. The fixture is checked to be one the text pass WOULD
// corrupt, so this test fails if a redaction pass is ever added over the
// whole result.
func TestScreenshotResultsAreNotTextRedacted(t *testing.T) {
	img, want := noiseImageWithAWSShapedBase64(t)
	if executor.SanitizeOutput(want) == want {
		t.Fatal("fixture is not discriminating: SanitizeOutput leaves it unchanged")
	}
	capFn := func(int) (*image.RGBA, int, int, error) {
		return img, img.Bounds().Dx(), img.Bounds().Dy(), nil
	}

	t.Run("take_screenshot", func(t *testing.T) {
		res := tools.TakeScreenshotWithCapture(map[string]any{}, capFn)
		if res.Status != "completed" {
			t.Fatalf("status %q: %s", res.Status, res.Error)
		}
		var shot tools.ScreenshotResponse
		if err := json.Unmarshal([]byte(res.Stdout), &shot); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if shot.ImageBase64 != want {
			t.Fatal("take_screenshot image is not byte-identical to the encoder output")
		}
	})

	t.Run("computer_action", func(t *testing.T) {
		res := tools.ComputerActionWithCapture(map[string]any{"action": "screenshot"}, capFn)
		if res.Status != "completed" {
			t.Fatalf("status %q: %s", res.Status, res.Error)
		}
		var action tools.ComputerActionResponse
		if err := json.Unmarshal([]byte(res.Stdout), &action); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if action.Screenshot == nil || action.Screenshot.ImageBase64 != want {
			t.Fatal("computer_action screenshot is not byte-identical to the encoder output")
		}
	})
}
