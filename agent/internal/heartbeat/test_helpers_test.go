package heartbeat

import (
	"reflect"
	"testing"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func newTestBrokerWithSessions(t *testing.T, sessions ...*sessionbroker.Session) *sessionbroker.Broker {
	t.Helper()

	broker := sessionbroker.New("/tmp/test-broker.sock", nil)
	sessionMap := make(map[string]*sessionbroker.Session, len(sessions))
	byIdentity := make(map[string][]*sessionbroker.Session)
	for _, session := range sessions {
		sessionMap[session.SessionID] = session
		byIdentity[session.IdentityKey] = append(byIdentity[session.IdentityKey], session)
	}

	setUnexportedField(t, broker, "sessions", sessionMap)
	setUnexportedField(t, broker, "byIdentity", byIdentity)
	return broker
}

func setUnexportedField(t *testing.T, target any, name string, value any) {
	t.Helper()

	v := reflect.ValueOf(target)
	if v.Kind() != reflect.Ptr || v.IsNil() {
		t.Fatalf("target must be a non-nil pointer, got %T", target)
	}

	field := v.Elem().FieldByName(name)
	if !field.IsValid() {
		t.Fatalf("field %q not found on %T", name, target)
	}

	reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem().Set(reflect.ValueOf(value))
}
