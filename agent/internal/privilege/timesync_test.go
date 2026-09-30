package privilege

import "testing"

func TestTimeCommandsRequireElevation(t *testing.T) {
	for _, kind := range []string{"time_resync", "time_set_timezone", "time_apply_policy"} {
		if !RequiresElevation(kind) {
			t.Fatalf("%s missing elevated registration", kind)
		}
	}
}
