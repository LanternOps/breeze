package unifi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The Integration API's list endpoints (/devices, /clients) are paginated via
// offset/limit/count/totalCount. get() must keep requesting with an advancing
// offset until it has collected totalCount elements, rather than returning
// only the first page (#5101 — surfaced while fixing #5087).
func TestGetFollowsPaginationOffset(t *testing.T) {
	tests := []struct {
		name       string
		pageSize   int
		totalItems int
	}{
		{"single page covers everything", 10, 4},
		{"exact multiple of two pages", 2, 4},
		{"three pages with a short last page", 3, 7},
		{"many small pages", 1, 9},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var requests int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&requests, 1)
				offset := 0
				if v := r.URL.Query().Get("offset"); v != "" {
					offset, _ = strconv.Atoi(v)
				}
				end := offset + tt.pageSize
				if end > tt.totalItems {
					end = tt.totalItems
				}
				if offset > end {
					offset = end
				}
				elems := make([]string, 0, end-offset)
				for i := offset; i < end; i++ {
					elems = append(elems, fmt.Sprintf(`{"id":"d%d","macAddress":"aa:bb:cc:dd:ee:%02d","name":"dev%d"}`, i, i, i))
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"data":[%s],"offset":%d,"limit":%d,"count":%d,"totalCount":%d}`,
					strings.Join(elems, ","), offset, tt.pageSize, len(elems), tt.totalItems)
			}))
			defer srv.Close()

			c := NewAPIClient(srv.URL, "k", srv.Client())
			data, status, err := c.get(context.Background(), "/devices")
			if err != nil {
				t.Fatalf("get error: %v", err)
			}
			if status != http.StatusOK {
				t.Fatalf("status = %d, want 200", status)
			}
			var got []json.RawMessage
			if uerr := json.Unmarshal(data, &got); uerr != nil {
				t.Fatalf("bad combined json: %v (data=%s)", uerr, data)
			}
			if len(got) != tt.totalItems {
				t.Fatalf("got %d elements, want %d — offset pagination not followed to completion", len(got), tt.totalItems)
			}
			wantRequests := (tt.totalItems + tt.pageSize - 1) / tt.pageSize
			if wantRequests == 0 {
				wantRequests = 1
			}
			if int(requests) != wantRequests {
				t.Fatalf("made %d requests, want %d", requests, wantRequests)
			}
		})
	}
}

// End-to-end through Poll(): the literal case the issue asks for — a fake
// controller that serves two pages of devices, asserting the second page's
// devices actually land in the snapshot instead of being silently dropped.
func TestPollCollectsDevicesAndClientsAcrossMultiplePages(t *testing.T) {
	devicePages := []string{
		`{"data":[{"id":"d1","macAddress":"aa:bb:cc:00:00:01","name":"dev1"}],` +
			`"offset":0,"limit":1,"count":1,"totalCount":2}`,
		`{"data":[{"id":"d2","macAddress":"aa:bb:cc:00:00:02","name":"dev2"}],` +
			`"offset":1,"limit":1,"count":1,"totalCount":2}`,
	}
	clientPages := []string{
		`{"data":[{"id":"c1","macAddress":"aa:bb:cc:00:01:01","type":"WIRED"}],` +
			`"offset":0,"limit":1,"count":1,"totalCount":2}`,
		`{"data":[{"id":"c2","macAddress":"aa:bb:cc:00:01:02","type":"WIRELESS"}],` +
			`"offset":1,"limit":1,"count":1,"totalCount":2}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		offset := 0
		if v := r.URL.Query().Get("offset"); v != "" {
			offset, _ = strconv.Atoi(v)
		}
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			_, _ = w.Write([]byte(`{"data":[{"id":"s1","name":"HQ"}]}`))
		case "/proxy/network/integration/v1/sites/s1/devices":
			_, _ = w.Write([]byte(devicePages[offset]))
		case "/proxy/network/integration/v1/sites/s1/clients":
			_, _ = w.Write([]byte(clientPages[offset]))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll error: %v", err)
	}
	if len(snap.Devices) != 2 {
		t.Fatalf("expected 2 devices across both pages, got %d: %+v", len(snap.Devices), snap.Devices)
	}
	if snap.Devices[0].ID != "d1" || snap.Devices[1].ID != "d2" {
		t.Fatalf("devices = %+v, want d1 then d2 (second page dropped?)", snap.Devices)
	}
	if len(snap.Clients) != 2 {
		t.Fatalf("expected 2 clients across both pages, got %d: %+v", len(snap.Clients), snap.Clients)
	}
	if snap.Clients[0].Mac != "aa:bb:cc:00:01:01" || snap.Clients[1].Mac != "aa:bb:cc:00:01:02" {
		t.Fatalf("clients = %+v, want both pages present", snap.Clients)
	}
}

// A page that decodes ZERO elements while the controller still claims more
// exist beyond the current offset (totalCount not yet reached) must error out
// rather than quietly returning whatever was collected so far — that would
// reproduce the exact silent-truncation bug #5101 fixed, just one layer down
// and behind an empty-page edge case instead of "no pagination at all".
func TestGetErrorsRatherThanSilentlyTruncatingOnEmptyPageBeforeTotal(t *testing.T) {
	pages := []string{
		`{"data":[{"id":"d0"}],"offset":0,"limit":1,"count":1,"totalCount":3}`,
		// Second page unexpectedly empty, but the controller still says 3 exist.
		`{"data":[],"offset":1,"limit":1,"count":0,"totalCount":3}`,
	}
	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		if int(n) > len(pages) {
			t.Errorf("unexpected extra request #%d — should have stopped after the empty page", n)
			_, _ = w.Write([]byte(`{"data":[]}`))
			return
		}
		_, _ = w.Write([]byte(pages[n-1]))
	}))
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())
	data, _, err := c.get(context.Background(), "/devices")
	if err == nil {
		t.Fatalf("expected an error for an empty page short of totalCount, got data=%s", data)
	}
	if int(requests) != 2 {
		t.Fatalf("made %d requests, want exactly 2 (stop at the empty page, don't retry forever)", requests)
	}
}

// A controller that lies about `count` — claiming more elements than it
// actually put in `data` — must not cause the client to skip real items. The
// client advances its offset by what it actually decoded from `data`, never
// the controller-asserted `count` field, so this desync self-corrects instead
// of silently losing elements.
func TestGetAdvancesByActualElementsNotClaimedCount(t *testing.T) {
	// Page 1 claims count:10 (matching totalCount) but only ships 2 elements —
	// a buggy or hostile controller. If the client trusted `count`, it would
	// jump straight past totalCount and never fetch the remaining real items.
	pages := []string{
		`{"data":[{"id":"d0"},{"id":"d1"}],"offset":0,"limit":10,"count":10,"totalCount":4}`,
		`{"data":[{"id":"d2"},{"id":"d3"}],"offset":2,"limit":10,"count":2,"totalCount":4}`,
	}
	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		if int(n) > len(pages) {
			// Defensive: a bug in this test's own accounting must not hang the
			// server goroutine or serve stale data silently.
			t.Errorf("unexpected extra request #%d", n)
			_, _ = w.Write([]byte(`{"data":[]}`))
			return
		}
		_, _ = w.Write([]byte(pages[n-1]))
	}))
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())
	data, _, err := c.get(context.Background(), "/devices")
	if err != nil {
		t.Fatalf("get error: %v", err)
	}
	var got []json.RawMessage
	if uerr := json.Unmarshal(data, &got); uerr != nil {
		t.Fatalf("bad combined json: %v", uerr)
	}
	if len(got) != 4 {
		t.Fatalf("got %d elements, want 4 — a claimed `count` of 10 on a 2-element page caused real items to be skipped", len(got))
	}
	if int(requests) != 2 {
		t.Fatalf("made %d requests, want 2 — offset did not advance correctly off the actual page size", requests)
	}
}

// A misbehaving controller that never lets the client's advancing offset
// reach its reported totalCount (a buggy or actively hostile controller —
// e.g. one that lies about totalCount) must not spin the collector forever.
// The hard page cap has to stop it after a bounded number of requests.
func TestGetStopsAtHardPageCapWhenControllerNeverAdvances(t *testing.T) {
	var requests int32
	const pageItems = 5
	// Comfortably beyond what maxListPages pages of pageItems each could ever
	// reach, so the loop can only terminate via the cap, never by satisfying
	// totalCount.
	const totalCount = (maxListPages + 50) * pageItems
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		elems := make([]string, pageItems)
		for i := range elems {
			elems[i] = fmt.Sprintf(`{"id":"d%d","macAddress":"aa:bb:cc:dd:ee:%02d"}`, i, i)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"data":[%s],"offset":0,"limit":%d,"count":%d,"totalCount":%d}`,
			strings.Join(elems, ","), pageItems, pageItems, totalCount)
	}))
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())

	done := make(chan struct{})
	var data json.RawMessage
	var err error
	go func() {
		data, _, err = c.get(context.Background(), "/devices")
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("get() did not return — the hard page cap failed to stop an offset that never catches up to totalCount")
	}

	if err == nil {
		t.Fatalf("expected an error when the hard page cap is hit, got data=%s", data)
	}
	if int(requests) != maxListPages {
		t.Fatalf("made %d requests, want exactly the cap (%d) — pagination did not stop where expected", requests, maxListPages)
	}
}
