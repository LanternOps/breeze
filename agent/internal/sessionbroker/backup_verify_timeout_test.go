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
