package workspaceindex

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sync"
	"testing"
	"time"
)

type receivedBatch struct {
	Cursor  string
	Entries []Entry
}

func decodeReceivedBatch(t *testing.T, r *http.Request) receivedBatch {
	t.Helper()

	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer zr.Close()

	var batch receivedBatch
	if err := json.NewDecoder(zr).Decode(&batch); err != nil {
		t.Fatalf("decode batch: %v", err)
	}
	return batch
}

func uploaderTestEntry(n int) Entry {
	path := fmt.Sprintf("dir/file-%02d.txt", n)
	return Entry{
		RelPath:    path,
		ParentPath: "dir",
		Name:       fmt.Sprintf("file-%02d.txt", n),
		Attrs:      map[string]any{},
	}
}

func TestUploaderFlushesAtExactEntryCap(t *testing.T) {
	var batches []receivedBatch
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batches = append(batches, decodeReceivedBatch(t, r))
		w.WriteHeader(http.StatusAccepted)
	}))
	uploader := NewUploader(client, "run-1", ConfigLimits{MaxBatchEntries: 2, MaxBatchBytes: 1_000_000})

	if err := uploader.Add(context.Background(), uploaderTestEntry(1)); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	if len(batches) != 0 {
		t.Fatalf("requests after first Add = %d, want 0", len(batches))
	}
	if err := uploader.Add(context.Background(), uploaderTestEntry(2)); err != nil {
		t.Fatalf("second Add: %v", err)
	}

	if len(batches) != 1 {
		t.Fatalf("requests after exact cap = %d, want 1", len(batches))
	}
	if got := entryRelPaths(batches[0].Entries); !reflect.DeepEqual(got, []string{"dir/file-01.txt", "dir/file-02.txt"}) {
		t.Fatalf("entry paths = %#v", got)
	}
}

func TestUploaderFlushesAtApproximateByteCap(t *testing.T) {
	var batches []receivedBatch
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batches = append(batches, decodeReceivedBatch(t, r))
		w.WriteHeader(http.StatusAccepted)
	}))
	uploader := NewUploader(client, "run-1", ConfigLimits{MaxBatchEntries: 100, MaxBatchBytes: 200})
	entry := uploaderTestEntry(1)
	entry.Attrs = map[string]any{"description": string(make([]byte, 500))}

	if err := uploader.Add(context.Background(), entry); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if len(batches) != 1 {
		t.Fatalf("requests after byte cap = %d, want 1", len(batches))
	}
	if got := entryRelPaths(batches[0].Entries); !reflect.DeepEqual(got, []string{entry.RelPath}) {
		t.Fatalf("entry paths = %#v", got)
	}
}

func TestUploaderDrainFlushesRemainderAndEmptyDrainIsNoOp(t *testing.T) {
	var batches []receivedBatch
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batches = append(batches, decodeReceivedBatch(t, r))
		w.WriteHeader(http.StatusAccepted)
	}))

	empty := NewUploader(client, "empty-run", ConfigLimits{})
	if err := empty.Drain(context.Background()); err != nil {
		t.Fatalf("empty Drain: %v", err)
	}
	if len(batches) != 0 {
		t.Fatalf("requests after empty Drain = %d, want 0", len(batches))
	}

	uploader := NewUploader(client, "run-1", ConfigLimits{MaxBatchEntries: 10, MaxBatchBytes: 1_000_000})
	for i := 1; i <= 2; i++ {
		if err := uploader.Add(context.Background(), uploaderTestEntry(i)); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	if err := uploader.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if err := uploader.Drain(context.Background()); err != nil {
		t.Fatalf("second empty Drain: %v", err)
	}

	if len(batches) != 1 {
		t.Fatalf("requests after drains = %d, want 1", len(batches))
	}
	if got := entryRelPaths(batches[0].Entries); !reflect.DeepEqual(got, []string{"dir/file-01.txt", "dir/file-02.txt"}) {
		t.Fatalf("entry paths = %#v", got)
	}
}

func TestUploaderSplitsTooLargeBatchesAndPreservesOrder(t *testing.T) {
	var mu sync.Mutex
	var requestSizes []int
	var delivered []string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := decodeReceivedBatch(t, r)
		mu.Lock()
		defer mu.Unlock()
		requestSizes = append(requestSizes, len(batch.Entries))
		if len(batch.Entries) > 2 {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		delivered = append(delivered, entryRelPaths(batch.Entries)...)
		w.WriteHeader(http.StatusAccepted)
	}))
	uploader := NewUploader(client, "run-1", ConfigLimits{MaxBatchEntries: 5, MaxBatchBytes: 1_000_000})

	for i := 1; i <= 5; i++ {
		if err := uploader.Add(context.Background(), uploaderTestEntry(i)); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}

	wantPaths := []string{"dir/file-01.txt", "dir/file-02.txt", "dir/file-03.txt", "dir/file-04.txt", "dir/file-05.txt"}
	if !reflect.DeepEqual(delivered, wantPaths) {
		t.Fatalf("delivered paths = %#v, want %#v", delivered, wantPaths)
	}
	if want := []int{5, 2, 3, 1, 2}; !reflect.DeepEqual(requestSizes, want) {
		t.Fatalf("request sizes = %#v, want %#v", requestSizes, want)
	}
}

func TestUploaderSingleEntryTooLargeSurfacesError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
	}))
	uploader := NewUploader(client, "run-1", ConfigLimits{MaxBatchEntries: 1, MaxBatchBytes: 1_000_000})

	err := uploader.Add(context.Background(), uploaderTestEntry(1))
	if !errors.Is(err, ErrBatchTooLarge) {
		t.Fatalf("Add error = %v, want errors.Is(_, ErrBatchTooLarge)", err)
	}
}

func TestUploaderUsesLastEntryAsCursorForEveryBatch(t *testing.T) {
	var cursors []string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := decodeReceivedBatch(t, r)
		cursors = append(cursors, batch.Cursor)
		w.WriteHeader(http.StatusAccepted)
	}))
	uploader := NewUploader(client, "run-1", ConfigLimits{MaxBatchEntries: 2, MaxBatchBytes: 1_000_000})

	for i := 1; i <= 5; i++ {
		if err := uploader.Add(context.Background(), uploaderTestEntry(i)); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	if err := uploader.Drain(context.Background()); err != nil {
		t.Fatalf("Drain: %v", err)
	}

	want := []string{"dir/file-02.txt", "dir/file-04.txt", "dir/file-05.txt"}
	if !reflect.DeepEqual(cursors, want) {
		t.Fatalf("cursors = %#v, want %#v", cursors, want)
	}
}

func TestUploaderTerminalServerErrorPropagates(t *testing.T) {
	origDelay := batchRetryDelay
	batchRetryDelay = time.Millisecond
	t.Cleanup(func() { batchRetryDelay = origDelay })

	tests := []struct {
		name string
		call func(context.Context, *Uploader) error
	}{
		{
			name: "Add",
			call: func(ctx context.Context, uploader *Uploader) error {
				return uploader.Add(ctx, uploaderTestEntry(1))
			},
		},
		{
			name: "Drain",
			call: func(ctx context.Context, uploader *Uploader) error {
				if err := uploader.Add(ctx, uploaderTestEntry(1)); err != nil {
					return err
				}
				return uploader.Drain(ctx)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var requests int
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.WriteHeader(http.StatusInternalServerError)
			}))
			limits := ConfigLimits{MaxBatchEntries: 10, MaxBatchBytes: 1_000_000}
			if tt.name == "Add" {
				limits.MaxBatchEntries = 1
			}
			err := tt.call(context.Background(), NewUploader(client, "run-1", limits))
			var httpErr *HTTPError
			if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusInternalServerError {
				t.Fatalf("error = %v, want terminal HTTP 500", err)
			}
			if requests != 3 {
				t.Fatalf("requests = %d, want client's 3 total attempts", requests)
			}
		})
	}
}

func entryRelPaths(entries []Entry) []string {
	paths := make([]string, len(entries))
	for i, entry := range entries {
		paths[i] = entry.RelPath
	}
	return paths
}
