package userhelper

import (
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// The broker caps every pre-auth frame at ipc.PreAuthMaxMessageSize on every
// platform. This runs the real helper's authenticate() for each role and
// binary kind it ships as, on whatever OS the suite runs on, and reads the
// request through a Conn holding that same cap.
func TestAuthenticate_RequestFitsPreAuthCap(t *testing.T) {
	cases := []struct {
		name       string
		role       ipc.HelperRole
		binaryKind string
		context    string
	}{
		{"system user helper", ipc.HelperRoleSystem, ipc.HelperBinaryUserHelper, ""},
		{"user helper", ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, ""},
		{"user desktop helper", ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession},
		{"login window desktop helper", ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextLoginWindow},
		{"system desktop helper", ipc.HelperRoleSystem, ipc.HelperBinaryDesktopHelper, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clientConn, serverConn := net.Pipe()
			defer func() { _ = clientConn.Close() }()
			defer func() { _ = serverConn.Close() }()

			type result struct {
				size int
				typ  string
				err  error
			}
			got := make(chan result, 1)
			go func() {
				srv := ipc.NewConn(serverConn)
				srv.SetMaxRecvSize(ipc.PreAuthMaxMessageSize)
				_ = srv.SetReadDeadline(time.Now().Add(10 * time.Second))
				env, err := srv.Recv()
				if err != nil {
					got <- result{err: err}
					return
				}
				got <- result{size: srv.LastRecvFrameSize(), typ: env.Type}
				_ = srv.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{Accepted: false, Reason: "test", Permanent: true})
			}()

			c := NewWithOptions("/unused", tc.role, tc.binaryKind, tc.context)
			c.conn = ipc.NewConn(clientConn)
			authDone := make(chan error, 1)
			go func() { authDone <- c.authenticate() }() // rejected by the server above

			var r result
			select {
			case r = <-got:
			case authErr := <-authDone:
				// authenticate returns after the rejection, or earlier when it
				// cannot build a request at all (no account entry for this uid,
				// as in some containers).
				select {
				case r = <-got:
				case <-time.After(2 * time.Second):
					t.Skipf("helper could not build an auth request on this host: %v", authErr)
				}
			case <-time.After(15 * time.Second):
				t.Fatal("broker side never received the auth request")
			}

			if r.err != nil {
				t.Fatalf("broker-side read under the pre-auth cap failed: %v", r.err)
			}
			if r.typ != ipc.TypeAuthRequest {
				t.Fatalf("first frame type = %q", r.typ)
			}
			// A wide margin, so growth is caught long before it breaks a
			// shipped helper.
			if r.size >= ipc.PreAuthMaxMessageSize/4 {
				t.Fatalf("auth request is %d bytes, too close to the %d byte cap", r.size, ipc.PreAuthMaxMessageSize)
			}
			t.Logf("auth request frame: %d bytes", r.size)
		})
	}
}
