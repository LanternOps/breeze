package workspaceindex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	defaultMaxBatchEntries = 2_000
	defaultMaxBatchBytes   = 900_000
	entryJSONOverhead      = 1
)

// Uploader buffers crawl entries and uploads them in bounded batches. It is
// intended for single-goroutine use by a walker's emit callback.
type Uploader struct {
	client     *Client
	runID      string
	maxEntries int
	maxBytes   int
	buf        []Entry
	bufBytes   int
	cursor     string
}

// NewUploader creates an uploader using server-provided batch limits. Zero
// limits use conservative defaults.
func NewUploader(c *Client, runID string, limits ConfigLimits) *Uploader {
	maxEntries := limits.MaxBatchEntries
	if maxEntries <= 0 {
		maxEntries = defaultMaxBatchEntries
	}
	maxBytes := limits.MaxBatchBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBatchBytes
	}

	return &Uploader{
		client:     c,
		runID:      runID,
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
	}
}

// Add buffers an entry and flushes when either configured batch limit is
// reached.
func (u *Uploader) Add(ctx context.Context, entry Entry) error {
	encoded, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("measure workspace index entry: %w", err)
	}

	u.buf = append(u.buf, entry)
	u.bufBytes += len(encoded) + entryJSONOverhead
	u.cursor = entry.RelPath
	if len(u.buf) < u.maxEntries && u.bufBytes < u.maxBytes {
		return nil
	}
	return u.flush(ctx)
}

// Drain uploads any entries still buffered. Draining an empty uploader is a
// no-op.
func (u *Uploader) Drain(ctx context.Context) error {
	return u.flush(ctx)
}

func (u *Uploader) flush(ctx context.Context) error {
	if len(u.buf) == 0 {
		return nil
	}
	if err := u.postBatch(ctx, u.buf, u.cursor); err != nil {
		return err
	}

	u.buf = u.buf[:0]
	u.bufBytes = 0
	u.cursor = ""
	return nil
}

func (u *Uploader) postBatch(ctx context.Context, entries []Entry, cursor string) error {
	err := u.client.PostBatch(ctx, u.runID, cursor, entries)
	if !errors.Is(err, ErrBatchTooLarge) {
		return err
	}
	if len(entries) == 1 {
		return err
	}

	middle := len(entries) / 2
	if err := u.postBatch(ctx, entries[:middle], entries[middle-1].RelPath); err != nil {
		return err
	}
	return u.postBatch(ctx, entries[middle:], cursor)
}
