package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeRetain(t *testing.T, raw string) RetainState {
	t.Helper()
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[{"id":"c1","type":"noop"}],"retainState":`+raw+`}`), &resp); err != nil {
		t.Fatalf("response decode must never fail on retainState %s: %v", raw, err)
	}
	if len(resp.Commands) != 1 || resp.Commands[0].ID != "c1" {
		t.Fatalf("a malformed retainState must not cost the beat its commands: %+v", resp.Commands)
	}
	return resp.RetainState
}

func TestRetainStateDecode(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want RetainState
	}{
		{"all", `["pam","helper","remoteManagement"]`, RetainState{PAM: true, Helper: true, RemoteManagement: true}},
		{"pam only", `["pam"]`, RetainState{PAM: true}},
		{"empty array", `[]`, RetainState{}},
		{"unknown names ignored", `["pam","futureThing"]`, RetainState{PAM: true}},
		{"mixed scalars keep valid strings", `["helper",7,null,true,"pam"]`, RetainState{Helper: true, PAM: true}},
		{"nested object stops parsing", `["helper",{"a":1},"pam"]`, RetainState{Helper: true}},
		{"nested array stops parsing", `["helper",["pam"],"remoteManagement"]`, RetainState{Helper: true}},
		{"object is empty", `{"pam":true}`, RetainState{}},
		{"number is empty", `3`, RetainState{}},
		{"string is empty", `"pam"`, RetainState{}},
		{"bool is empty", `true`, RetainState{}},
		{"null is empty", `null`, RetainState{}},
		{"case sensitive", `["PAM","Helper","remotemanagement"]`, RetainState{}},
		{"oversized entry ignored", `["` + strings.Repeat("a", 4096) + `","pam"]`, RetainState{PAM: true}},
		{"oversized known-prefix entry ignored", `["pam` + strings.Repeat(" ", 64) + `"]`, RetainState{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeRetain(t, tc.raw); got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

func TestRetainStateDecodeBoundsEntries(t *testing.T) {
	// "pam" past the 16-entry cap must not be honoured, however long the array.
	raw := "[" + strings.Repeat(`"x",`, 5000) + `"pam"]`
	if got := decodeRetain(t, raw); got.PAM {
		t.Fatal("entries beyond the cap must be ignored")
	}
	// The 16th entry is still inside the cap.
	raw = "[" + strings.Repeat(`"x",`, retainStateMaxEntries-1) + `"pam"]`
	if got := decodeRetain(t, raw); !got.PAM {
		t.Fatal("an entry inside the cap must be honoured")
	}
}

func TestRetainStateAbsentIsZero(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.RetainState != (RetainState{}) {
		t.Fatalf("absent retainState must be the zero value, got %+v", resp.RetainState)
	}
}

// The heartbeat response is decoded with json.NewDecoder in production; make
// sure a malformed retainState is tolerated through that path too.
func TestRetainStateDecoderPathTolerant(t *testing.T) {
	var resp HeartbeatResponse
	body := `{"commands":[],"retainState":{"x":[1,2,{"y":"z"}]},"upgradeTo":"9.9.9"}`
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.UpgradeTo != "9.9.9" || resp.RetainState != (RetainState{}) {
		t.Fatalf("unexpected decode: upgradeTo=%q retain=%+v", resp.UpgradeTo, resp.RetainState)
	}
}
