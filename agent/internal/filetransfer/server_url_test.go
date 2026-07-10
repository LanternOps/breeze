package filetransfer

import (
	"fmt"
	"sync"
	"testing"
)

func TestSetServerURL(t *testing.T) {
	m := NewManager(&Config{ServerURL: "https://primary.example.com"})
	m.SetServerURL("https://backup.example.com")

	if got := m.serverURL(); got != "https://backup.example.com" {
		t.Fatalf("serverURL = %q, want promoted URL", got)
	}
}

func TestSetServerURLConcurrentWithReads(t *testing.T) {
	m := NewManager(&Config{ServerURL: "https://primary.example.com"})

	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			m.SetServerURL(fmt.Sprintf("https://backup-%d.example.com", i))
		}(i)
		go func() {
			defer wg.Done()
			_ = m.serverURL()
		}()
	}
	wg.Wait()

	if got := m.serverURL(); got == "" {
		t.Fatal("serverURL became empty after concurrent updates")
	}
}
