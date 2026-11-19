package sessionbroker

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBackupVerificationTimeoutCancelsHelperAndAbsorbsLateResult(t *testing.T) {
	for _, commandType := range []string{"backup_verify", "backup_test_restore"} {
		t.Run(commandType, func(t *testing.T) {
			serverConn, clientConn := net.Pipe()
			defer func() { _ = serverConn.Close() }()
			defer func() { _ = clientConn.Close() }()

			brokerSideConn := ipc.NewConn(serverConn)
			helperSideConn := ipc.NewConn(clientConn)

			unsolicited := make(chan *ipc.Envelope, 2)
			session := &Session{
				SessionID: "backup-verify-timeout-test",
				conn:      brokerSideConn,
				pending:   make(map[string]pendingResponse),
				done:      make(chan struct{}),
			}
			go session.RecvLoop(func(_ *Session, env *ipc.Envelope) {
				unsolicited <- env
			})

			broker := &Broker{
				sessions:   make(map[string]*Session),
				byIdentity: make(map[string][]*Session),
			}
			broker.SetBackupSession(session)

			cancelSeen := make(chan string, 1)
			helperErr := make(chan error, 1)

			go func() {
				originalEnv, err := helperSideConn.Recv()
				if err != nil {
					helperErr <- fmt.Errorf("recv original command: %w", err)
					return
				}

				var originalReq backupipc.BackupCommandRequest
				if err := json.Unmarshal(originalEnv.Payload, &originalReq); err != nil {
					helperErr <- fmt.Errorf("decode original command: %w", err)
					return
				}
				if originalReq.CommandType != commandType {
					helperErr <- fmt.Errorf("original command type = %q, want %q", originalReq.CommandType, commandType)
					return
				}

				stopEnv, err := helperSideConn.Recv()
				if err != nil {
					helperErr <- fmt.Errorf("recv stop command: %w", err)
					return
				}

				var stopReq backupipc.BackupCommandRequest
				if err := json.Unmarshal(stopEnv.Payload, &stopReq); err != nil {
					helperErr <- fmt.Errorf("decode stop command: %w", err)
					return
				}
				if stopReq.CommandType != "backup_stop" {
					helperErr <- fmt.Errorf("stop command type = %q, want backup_stop", stopReq.CommandType)
					return
				}

				var stopPayload struct {
					JobID string `json:"jobId"`
				}
				if err := json.Unmarshal(stopReq.Payload, &stopPayload); err != nil {
					helperErr <- fmt.Errorf("decode stop payload: %w", err)
					return
				}
				cancelSeen <- stopPayload.JobID

				// Mirror the real helper ordering: the cancelled original command
				// produces its correlated result before backup_stop can report
				// drained=true.
				originalResult := backupipc.BackupCommandResult{
					CommandID: originalReq.CommandID,
					Success:   false,
					Stderr:    "context canceled",
				}
				if err := helperSideConn.SendTyped(originalEnv.ID, backupipc.TypeBackupResult, originalResult); err != nil {
					helperErr <- fmt.Errorf("send original result: %w", err)
					return
				}

				stopResult := backupipc.BackupCommandResult{
					CommandID: stopReq.CommandID,
					Success:   true,
					Stdout:    `{"stopped":true,"drained":true}`,
				}
				if err := helperSideConn.SendTyped(stopEnv.ID, backupipc.TypeBackupResult, stopResult); err != nil {
					helperErr <- fmt.Errorf("send stop result: %w", err)
					return
				}

				helperErr <- nil
			}()

			commandID := "verify-timeout-" + commandType
			_, err := broker.ForwardBackupCommand(
				commandID,
				commandType,
				nil,
				25*time.Millisecond,
				false,
			)
			if !errors.Is(err, ErrCommandTimeout) {
				t.Fatalf("ForwardBackupCommand error = %v, want ErrCommandTimeout", err)
			}

			select {
			case got := <-cancelSeen:
				if got != commandID {
					t.Fatalf("backup_stop jobId = %q, want %q", got, commandID)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for targeted backup_stop")
			}

			select {
			case err := <-helperErr:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for helper exchange")
			}

			// The original late result must remain correlated with the timed-out
			// request. If it leaks here, heartbeat would forward a second terminal
			// result to the server.
			select {
			case env := <-unsolicited:
				t.Fatalf("late backup result escaped as unsolicited: type=%s id=%s", env.Type, env.ID)
			case <-time.After(100 * time.Millisecond):
			}
		})
	}
}

// The helper derives its run budget from the request's TimeoutMs (minus
// backupipc.VerifyRunMargin), so the forward wait the heartbeat chose from the
// command's scaled timeBudgetSeconds must reach the helper unchanged. Pins
// that contract for both verification commands, at the base and a scaled
// budget.
func TestBackupVerificationForwardCarriesTimeoutToHelper(t *testing.T) {
	for _, commandType := range []string{"backup_verify", "backup_test_restore"} {
		for _, timeout := range []time.Duration{backupipc.VerifyCommandTimeout, 395 * time.Minute, backupipc.VerifyMaxCommandTimeout} {
			t.Run(fmt.Sprintf("%s/%s", commandType, timeout), func(t *testing.T) {
				serverConn, clientConn := net.Pipe()
				defer func() { _ = serverConn.Close() }()
				defer func() { _ = clientConn.Close() }()

				session := &Session{
					SessionID: "backup-verify-timeout-carry",
					conn:      ipc.NewConn(serverConn),
					pending:   make(map[string]pendingResponse),
					done:      make(chan struct{}),
				}
				go session.RecvLoop(func(_ *Session, _ *ipc.Envelope) {})
				broker := &Broker{
					sessions:   make(map[string]*Session),
					byIdentity: make(map[string][]*Session),
				}
				broker.SetBackupSession(session)

				helper := ipc.NewConn(clientConn)
				gotTimeoutMs := make(chan int64, 1)
				go func() {
					env, err := helper.Recv()
					if err != nil {
						gotTimeoutMs <- -1
						return
					}
					var req backupipc.BackupCommandRequest
					if err := json.Unmarshal(env.Payload, &req); err != nil {
						gotTimeoutMs <- -1
						return
					}
					gotTimeoutMs <- req.TimeoutMs
					_ = helper.SendTyped(env.ID, backupipc.TypeBackupResult, backupipc.BackupCommandResult{
						CommandID: req.CommandID,
						Success:   true,
						Stdout:    `{}`,
					})
				}()

				if _, err := broker.ForwardBackupCommand("carry-"+commandType, commandType, []byte(`{}`), timeout, false); err != nil {
					t.Fatalf("ForwardBackupCommand: %v", err)
				}
				select {
				case got := <-gotTimeoutMs:
					if got != timeout.Milliseconds() {
						t.Fatalf("helper saw TimeoutMs = %d, want %d", got, timeout.Milliseconds())
					}
				case <-time.After(2 * time.Second):
					t.Fatal("helper never received the request")
				}
			})
		}
	}
}
