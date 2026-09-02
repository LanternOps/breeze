package pamactuator

import (
	"errors"
	"reflect"
	"testing"
)

func TestCompleteSuspendedHandoffRollsBackUntilAcknowledged(t *testing.T) {
	sendErr := errors.New("encode response")
	ackErr := errors.New("decode acknowledgement")
	tests := []struct {
		name      string
		send      func() error
		awaitAck  func() error
		want      error
		wantOrder []string
	}{
		{name: "response send failure", send: func() error { return sendErr }, want: sendErr,
			wantOrder: []string{"send", "rollback"}},
		{name: "acknowledgement failure", send: func() error { return nil }, awaitAck: func() error { return ackErr }, want: ackErr,
			wantOrder: []string{"send", "ack", "rollback"}},
		{name: "acknowledged", send: func() error { return nil }, awaitAck: func() error { return nil },
			wantOrder: []string{"send", "ack"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var order []string
			err := completeSuspendedHandoff(
				func() error {
					order = append(order, "send")
					return tt.send()
				},
				func() error {
					order = append(order, "ack")
					if tt.awaitAck == nil {
						return nil
					}
					return tt.awaitAck()
				},
				func() { order = append(order, "rollback") },
			)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
			if !reflect.DeepEqual(order, tt.wantOrder) {
				t.Fatalf("order = %v, want %v", order, tt.wantOrder)
			}
		})
	}
}
