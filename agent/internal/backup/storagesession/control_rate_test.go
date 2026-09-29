package storagesession

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func recordPacing(t *testing.T) *[]time.Duration {
	t.Helper()
	var mu sync.Mutex
	paced := []time.Duration{}
	orig := paceSleep
	paceSleep = func(_ context.Context, d time.Duration) error {
		mu.Lock()
		paced = append(paced, d)
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { paceSleep = orig })
	return &paced
}

func pacedWriteProvider(t *testing.T, b *fakeWriteBackend, rate *ControlRate) *WriteProvider {
	t.Helper()
	d := testWriteDescriptor(b, time.Now())
	d.ControlRate = rate
	creds := Credentials{AgentID: testAgentID, AgentToken: testAgentToken, ControlPlaneOrigins: []string{b.control.URL}}
	p, err := NewWriteProvider(context.Background(), d, creds, Options{ControlClient: b.control.Client(), StorageClient: b.storage.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func TestControlCallsFollowTheAdvertisedRate(t *testing.T) {
	paced := recordPacing(t)
	b := newFakeWriteBackend(t)
	p := pacedWriteProvider(t, b, &ControlRate{PerMinute: 600, Burst: 20})
	for i := 0; i < 25; i++ {
		if _, err := p.List(objKey("files/")); err != nil {
			t.Fatal(err)
		}
	}
	if len(*paced) < 4 || len(*paced) > 6 {
		t.Fatalf("paced %d of 25 calls, want the ~5 after a burst of 20", len(*paced))
	}
	for _, d := range *paced {
		if d > time.Second {
			t.Fatalf("waits %v exceed the advertised 600 a minute", *paced)
		}
	}
}

func TestControlCallsStayConservativeWithoutAnAdvertisedRate(t *testing.T) {
	paced := recordPacing(t)
	b := newFakeWriteBackend(t)
	p := pacedWriteProvider(t, b, nil)
	for i := 0; i < 15; i++ {
		if _, err := p.List(objKey("files/")); err != nil {
			t.Fatal(err)
		}
	}
	if len(*paced) < 4 || len(*paced) > 6 {
		t.Fatalf("paced %d of 15 calls, want the ~5 after a burst of 10", len(*paced))
	}
	if (*paced)[0] < 2*time.Second {
		t.Fatalf("waits %v are not the conservative 20 a minute", *paced)
	}
}

func TestParsePayloadControlRate(t *testing.T) {
	for _, tc := range []struct {
		rate    any
		wantErr bool
	}{
		{map[string]any{"perMinute": 600, "burst": 600}, false},
		{map[string]any{"perMinute": 0, "burst": 10}, true},
		{map[string]any{"perMinute": 600, "burst": 0}, true},
		{map[string]any{"perMinute": 1000000, "burst": 10}, true},
	} {
		raw, _ := json.Marshal(map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["controlRate"] = tc.rate })})
		d, err := ParsePayload(raw, time.Now())
		if tc.wantErr != (err != nil) {
			t.Fatalf("controlRate %v: err = %v", tc.rate, err)
		}
		if err == nil && (d.ControlRate == nil || d.ControlRate.PerMinute != 600) {
			t.Fatalf("controlRate not parsed: %+v", d.ControlRate)
		}
	}
}
