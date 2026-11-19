package desktop

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// multicastDNSModeOf reads the mDNS mode a SettingEngine will hand to pion's
// ICE agent. The field is unexported, so it is read by reflection; if a pion
// upgrade renames it, this fails rather than passing vacuously.
func multicastDNSModeOf(t *testing.T, se webrtc.SettingEngine) ice.MulticastDNSMode {
	t.Helper()
	candidates := reflect.ValueOf(se).FieldByName("candidates")
	if !candidates.IsValid() {
		t.Fatal("webrtc.SettingEngine has no 'candidates' field; update this test for the pion version in go.mod")
	}
	mode := candidates.FieldByName("MulticastDNSMode")
	if !mode.IsValid() {
		t.Fatal("SettingEngine.candidates has no 'MulticastDNSMode' field; update this test for the pion version in go.mod")
	}
	return ice.MulticastDNSMode(mode.Uint())
}

// #12240: pion's zero value is promoted to MulticastDNSModeQueryOnly, which
// opens a multicast socket in every remote-desktop session. On macOS that
// socket lives in the user-session desktop helper and can raise the Local
// Network privacy prompt. Every desktop peer connection must run with mDNS
// disabled.
func TestDesktopSettingEngineDisablesMulticastDNS(t *testing.T) {
	if got := multicastDNSModeOf(t, newDesktopSettingEngine()); got != ice.MulticastDNSModeDisabled {
		t.Fatalf("desktop SettingEngine mDNS mode = %d, want MulticastDNSModeDisabled (%d)", got, ice.MulticastDNSModeDisabled)
	}
}

// obfuscateHostCandidates rewrites every host candidate's address in an SDP to
// a "<uuid>.local" name, the way browsers and webviews publish host candidates
// when the page holds no camera/microphone permission (the Breeze viewer
// never does). It returns the new SDP and how many candidates it rewrote.
func obfuscateHostCandidates(sdp string) (string, int) {
	lines := strings.Split(sdp, "\r\n")
	n := 0
	for i, line := range lines {
		if !strings.HasPrefix(line, "a=candidate:") || !strings.Contains(line, " typ host") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		n++
		fields[4] = fmt.Sprintf("1f0e4c2a-7b3d-4e5f-9a8b-%012d.local", n)
		lines[i] = strings.Join(fields, " ")
	}
	return strings.Join(lines, "\r\n"), n
}

// With mDNS disabled the agent discards a viewer's ".local" host candidates.
// A LAN session must still connect: the viewer checks the agent's real-IP host
// candidates and the agent learns the viewer as a peer-reflexive candidate.
// This passed before the #12240 change too; it guards the change against a
// LAN regression on every platform (the desktop helper on macOS, the agent's
// heartbeat package elsewhere — both build peers from newDesktopSettingEngine).
func TestDesktopPeerConnectsWhenViewerHostCandidatesAreMDNSNames(t *testing.T) {
	// The "viewer" side. Its own mDNS mode does not matter to what is tested
	// (it only ever sees the agent's IP candidates); disabled keeps the test
	// from opening a multicast socket.
	viewerSE := webrtc.SettingEngine{}
	viewerSE.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	viewer, err := webrtc.NewAPI(webrtc.WithSettingEngine(viewerSE)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = viewer.Close() }()

	agentPC, err := webrtc.NewAPI(webrtc.WithSettingEngine(newDesktopSettingEngine())).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = agentPC.Close() }()

	agentConnected := make(chan struct{})
	agentPC.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		if s == webrtc.ICEConnectionStateConnected {
			select {
			case <-agentConnected:
			default:
				close(agentConnected)
			}
		}
	})
	opened := make(chan struct{})
	agentPC.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() { close(opened) })
	})

	if _, err := viewer.CreateDataChannel("probe", nil); err != nil {
		t.Fatal(err)
	}
	offer, err := viewer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(viewer)
	if err := viewer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered

	sdp, rewritten := obfuscateHostCandidates(viewer.LocalDescription().SDP)
	if rewritten == 0 {
		t.Skip("viewer gathered no host candidates on this host (no non-loopback interface)")
	}
	if strings.Contains(sdp, " typ host") && !strings.Contains(sdp, ".local") {
		t.Fatal("offer rewrite left IP host candidates in place; the test would not exercise .local candidates")
	}

	if err := agentPC.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		t.Fatalf("agent rejected an offer whose host candidates are .local names: %v", err)
	}
	answer, err := agentPC.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	agentGathered := webrtc.GatheringCompletePromise(agentPC)
	if err := agentPC.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-agentGathered

	// The agent's own host candidates must still be gathered, as IPs.
	agentHosts := 0
	for _, line := range strings.Split(agentPC.LocalDescription().SDP, "\r\n") {
		if strings.HasPrefix(line, "a=candidate:") && strings.Contains(line, " typ host") {
			agentHosts++
			if strings.Contains(line, ".local") {
				t.Fatalf("agent published an mDNS host candidate: %q", line)
			}
		}
	}
	if agentHosts == 0 {
		t.Fatal("agent gathered no host candidates with mDNS disabled")
	}

	if err := viewer.SetRemoteDescription(*agentPC.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	select {
	case <-agentConnected:
	case <-time.After(15 * time.Second):
		t.Fatalf("agent ICE never connected; state=%s", agentPC.ICEConnectionState())
	}
	select {
	case <-opened:
	case <-time.After(15 * time.Second):
		t.Fatal("data channel never opened over the peer-reflexive pair")
	}
}
