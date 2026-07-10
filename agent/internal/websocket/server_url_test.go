package websocket

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestSetServerURLUpdatesBuildWSURL(t *testing.T) {
	c := newTestClient("https://primary.example.com", noopHandler)

	c.SetServerURL("https://backup.example.com")

	got, err := c.buildWSURL()
	if err != nil {
		t.Fatalf("buildWSURL error: %v", err)
	}
	if want := "wss://backup.example.com/api/v1/agent-ws/test-agent-001/ws"; got != want {
		t.Fatalf("buildWSURL = %q, want %q", got, want)
	}
}

func TestSetServerURLConcurrentWithBuildWSURL(t *testing.T) {
	c := newTestClient("https://primary.example.com", noopHandler)

	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			c.SetServerURL(fmt.Sprintf("https://backup-%d.example.com", i))
		}(i)
		go func() {
			defer wg.Done()
			got, err := c.buildWSURL()
			if err != nil {
				t.Errorf("buildWSURL error: %v", err)
				return
			}
			if !strings.HasSuffix(got, "/api/v1/agent-ws/test-agent-001/ws") {
				t.Errorf("buildWSURL = %q, want agent WebSocket path", got)
			}
		}()
	}
	wg.Wait()
}
