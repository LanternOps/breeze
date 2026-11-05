package oemupdates

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// allowlistJSON is the agent's own list of the Authenticode publishers it will
// run and the hosts it will download from. It is compiled in: nothing the API
// sends can add to it. The API's manifest contract test reads this file too, so
// an open gate cannot name a URL the agent would refuse.
//
// It is per role, not per lane: the tool installer and each named prerequisite
// have their own publishers and hosts. A lane-wide list would let a payload
// pass any binary signed by a prerequisite's publisher (Microsoft) off as the
// vendor tool's installer and run it as SYSTEM.
//
// The values are researched, not confirmed on hardware; each vendor's lab wave
// (Dell W10, HP W14) confirms the real signer names and download hosts.
//
//go:embed allowlist.json
var allowlistJSON []byte

type laneTrust struct {
	Tool          LaneAllowlist            `json:"tool"`
	Prerequisites map[string]LaneAllowlist `json:"prerequisites"`
}

var compiledAllowlists = mustParseAllowlist(allowlistJSON)

func mustParseAllowlist(raw []byte) map[string]laneTrust {
	var m map[string]laneTrust
	if err := json.Unmarshal(raw, &m); err != nil {
		panic(fmt.Sprintf("oemupdates: allowlist.json is invalid: %v", err))
	}
	for lane, t := range m {
		if !IsLane(lane) {
			panic(fmt.Sprintf("oemupdates: allowlist.json names unknown lane %q", lane))
		}
		checkAllowlist(lane+".tool", t.Tool)
		for name, p := range t.Prerequisites {
			checkAllowlist(lane+".prerequisites."+name, p)
		}
	}
	return m
}

func checkAllowlist(where string, a LaneAllowlist) {
	if len(a.Publishers) == 0 || len(a.Hosts) == 0 {
		panic(fmt.Sprintf("oemupdates: allowlist.json %s needs publishers and hosts", where))
	}
	for _, h := range a.Hosts {
		if h == "" || h != strings.ToLower(h) || strings.ContainsAny(h, "/:@ ") {
			panic(fmt.Sprintf("oemupdates: allowlist.json %s host %q must be a bare lowercase hostname", where, h))
		}
	}
	for _, p := range a.Publishers {
		if p == "" {
			panic(fmt.Sprintf("oemupdates: allowlist.json %s has an empty publisher", where))
		}
	}
}

func copyAllowlist(a LaneAllowlist) LaneAllowlist {
	return LaneAllowlist{
		Publishers: append([]string(nil), a.Publishers...),
		Hosts:      append([]string(nil), a.Hosts...),
	}
}

// laneAllowlist returns a copy of the compiled list for lane's tool.
func laneAllowlist(lane string) (LaneAllowlist, bool) {
	t, ok := compiledAllowlists[lane]
	if !ok {
		return LaneAllowlist{}, false
	}
	return copyAllowlist(t.Tool), true
}

// prerequisiteAllowlist returns a copy of the compiled list for one of lane's
// named prerequisites.
func prerequisiteAllowlist(lane, name string) (LaneAllowlist, bool) {
	t, ok := compiledAllowlists[lane]
	if !ok {
		return LaneAllowlist{}, false
	}
	p, ok := t.Prerequisites[name]
	if !ok {
		return LaneAllowlist{}, false
	}
	return copyAllowlist(p), true
}
