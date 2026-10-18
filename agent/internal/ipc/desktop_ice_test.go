package ipc

import (
	"strings"
	"testing"
)

func TestICECandidateValidate(t *testing.T) {
	long := strings.Repeat("a", MaxICECandidateBytes+1)
	mid := "0"
	longMid := strings.Repeat("m", 65)
	longFrag := strings.Repeat("u", 257)
	cases := []struct {
		name string
		c    ICECandidate
		ok   bool
	}{
		{"relay candidate", ICECandidate{Candidate: "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay", SDPMid: &mid}, true},
		{"empty candidate is end-of-candidates, not a candidate", ICECandidate{Candidate: ""}, false},
		{"oversized candidate", ICECandidate{Candidate: long}, false},
		{"oversized sdpMid", ICECandidate{Candidate: "candidate:x", SDPMid: &longMid}, false},
		{"oversized usernameFragment", ICECandidate{Candidate: "candidate:x", UsernameFragment: &longFrag}, false},
	}
	for _, tc := range cases {
		if err := tc.c.Validate(); (err == nil) != tc.ok {
			t.Errorf("%s: Validate() = %v, want ok=%v", tc.name, err, tc.ok)
		}
	}
}
