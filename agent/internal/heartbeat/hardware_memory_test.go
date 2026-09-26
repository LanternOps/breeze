package heartbeat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)

// captureHardwarePUT starts a server that records the raw JSON body of the
// first PUT /api/v1/agents/agent-1/hardware.
func captureHardwarePUT(t *testing.T) (*httptest.Server, chan map[string]json.RawMessage) {
	t.Helper()
	received := make(chan map[string]json.RawMessage, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v1/agents/agent-1/hardware" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			t.Errorf("decode: %v (%s)", err, body)
		}
		select {
		case received <- fields:
		default:
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server, received
}

func newMemoryHWTestHeartbeat(serverURL string) *Heartbeat {
	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: serverURL}, "1.2.3", nil, nil)
	h.hardwareCollectFn = func() (*collectors.HardwareInfo, error) {
		return &collectors.HardwareInfo{CPUModel: "Test CPU", CPUCores: 4, CPUThreads: 8, RAMTotalMB: 32768, DiskTotalGB: 512}, nil
	}
	return h
}

func awaitHardware(t *testing.T, ch chan map[string]json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	select {
	case got := <-ch:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("hardware inventory was not sent")
		return nil
	}
}

func TestSendHardwareInventoryIncludesMemory(t *testing.T) {
	server, received := captureHardwarePUT(t)
	h := newMemoryHWTestHeartbeat(server.URL)
	slots := 2
	capMb := 16384
	h.memoryCollectFn = func() (*collectors.MemoryInfo, error) {
		return &collectors.MemoryInfo{SlotsTotal: &slots, Modules: []collectors.MemoryModule{
			{SlotKey: "smbios:0x1100", Locator: "DIMM_A1", Populated: true, CapacityMb: &capMb},
			{SlotKey: "smbios:0x1101", Locator: "DIMM_A2"},
		}}, nil
	}

	h.sendHardwareInventory()
	got := awaitHardware(t, received)

	if string(got["cpuModel"]) != `"Test CPU"` || string(got["ramTotalMb"]) != `32768` {
		t.Fatalf("base hardware fields not flattened into the body: %v", got)
	}
	var mem collectors.MemoryInfo
	if err := json.Unmarshal(got["memory"], &mem); err != nil {
		t.Fatalf("memory key: %v (%s)", err, got["memory"])
	}
	if len(mem.Modules) != 2 || mem.Modules[0].SlotKey != "smbios:0x1100" || *mem.SlotsTotal != 2 {
		t.Fatalf("memory = %+v", mem)
	}
}

func TestSendHardwareInventoryOmitsMemoryOnError(t *testing.T) {
	for name, fn := range map[string]func() (*collectors.MemoryInfo, error){
		"collection error": func() (*collectors.MemoryInfo, error) { return nil, errors.New("smbios: truncated") },
		"unsupported":      func() (*collectors.MemoryInfo, error) { return nil, collectors.ErrMemoryUnsupported },
		"panic":            func() (*collectors.MemoryInfo, error) { panic("boom") },
		"nil without error": func() (*collectors.MemoryInfo, error) {
			return nil, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			server, received := captureHardwarePUT(t)
			h := newMemoryHWTestHeartbeat(server.URL)
			h.memoryCollectFn = fn

			h.sendHardwareInventory()
			got := awaitHardware(t, received)

			if _, ok := got["memory"]; ok {
				t.Fatalf("memory key sent on failure: %s", got["memory"])
			}
			if string(got["cpuModel"]) != `"Test CPU"` {
				t.Fatalf("base hardware not sent: %v", got)
			}
		})
	}
}

func TestSendHardwareInventoryMemoryTimeoutStillSendsBase(t *testing.T) {
	server, received := captureHardwarePUT(t)
	h := newMemoryHWTestHeartbeat(server.URL)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	h.memoryCollectFn = func() (*collectors.MemoryInfo, error) {
		<-release
		return nil, nil
	}
	h.memoryCollectTimeout = 50 * time.Millisecond

	h.sendHardwareInventory()
	got := awaitHardware(t, received)
	if _, ok := got["memory"]; ok {
		t.Fatalf("memory key sent after timeout")
	}
	if string(got["cpuModel"]) != `"Test CPU"` {
		t.Fatalf("base hardware not sent: %v", got)
	}
}

// A base hardware failure still aborts the send: memory never goes out alone.
func TestSendHardwareInventoryHardwareErrorSendsNothing(t *testing.T) {
	server, received := captureHardwarePUT(t)
	h := newMemoryHWTestHeartbeat(server.URL)
	h.hardwareCollectFn = func() (*collectors.HardwareInfo, error) { return nil, errors.New("gopsutil failed") }
	memCalled := false
	h.memoryCollectFn = func() (*collectors.MemoryInfo, error) { memCalled = true; return nil, nil }

	h.sendHardwareInventory()
	select {
	case got := <-received:
		t.Fatalf("unexpected send: %v", got)
	case <-time.After(200 * time.Millisecond):
	}
	if memCalled {
		t.Fatal("memory collected despite hardware failure")
	}
}
