package oemupdates

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// allowlistJSON is the agent's own list, per lane, of the Authenticode publishers
// it will run and the hosts it will download from. It is compiled in: nothing
// the API sends can add to it. The API's manifest contract test reads this file
// too, so an open gate cannot name a URL the agent would refuse.
//
// The Dell values are researched, not confirmed on hardware; the Dell lab wave
// (W10) confirms the real signer names and download hosts.
//
//go:embed allowlist.json
var allowlistJSON []byte

var compiledAllowlists = mustParseAllowlist(allowlistJSON)

func mustParseAllowlist(raw []byte) map[string]LaneAllowlist {
	var m map[string]LaneAllowlist
	if err := json.Unmarshal(raw, &m); err != nil {
		panic(fmt.Sprintf("oemupdates: allowlist.json is invalid: %v", err))
	}
	for lane, a := range m {
		if !IsLane(lane) {
			panic(fmt.Sprintf("oemupdates: allowlist.json names unknown lane %q", lane))
		}
		for _, h := range a.Hosts {
			if h == "" || h != strings.ToLower(h) || strings.ContainsAny(h, "/:@ ") {
				panic(fmt.Sprintf("oemupdates: allowlist.json host %q must be a bare lowercase hostname", h))
			}
		}
		for _, p := range a.Publishers {
			if p == "" {
				panic("oemupdates: allowlist.json has an empty publisher")
			}
		}
	}
	return m
}

// laneAllowlist returns a copy of the compiled list for lane.
func laneAllowlist(lane string) (LaneAllowlist, bool) {
	a, ok := compiledAllowlists[lane]
	if !ok {
		return LaneAllowlist{}, false
	}
	return LaneAllowlist{
		Publishers: append([]string(nil), a.Publishers...),
		Hosts:      append([]string(nil), a.Hosts...),
	}, true
}
