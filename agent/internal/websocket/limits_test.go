package websocket

import (
	"encoding/base64"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// TestMaxMessageSizeCoversLargestLegitimateFrame pins the relationship between
// the WS read limit and the largest legitimate server→agent frame: a
// file_write command carrying base64 content up to tools.MaxFileWriteSize
// decoded. Exceeding SetReadLimit is not a graceful rejection — gorilla
// returns ErrReadLimit and closes the connection — so the read limit must
// keep generous (>= 2x) headroom over the largest legit frame. If a future
// change bumps MaxFileWriteSize, this test fails on purpose: re-audit the
// frame sizes (issue #2399) and resize maxMessageSize deliberately, and keep
// the API-side caps in sync (fileUploadBodySchema in
// apps/api/src/routes/systemTools/schemas.ts and the pending-command payload
// budget in apps/api/src/routes/agentWs.ts).
func TestMaxMessageSizeCoversLargestLegitimateFrame(t *testing.T) {
	encodedFileWrite := base64.StdEncoding.EncodedLen(tools.MaxFileWriteSize)

	if maxMessageSize < 2*encodedFileWrite {
		t.Fatalf(
			"maxMessageSize (%d) must be at least 2x the largest legitimate frame (file_write, %d bytes base64-encoded of MaxFileWriteSize=%d decoded); re-audit issue #2399 before changing either constant",
			maxMessageSize, encodedFileWrite, tools.MaxFileWriteSize,
		)
	}

	// Sanity ceiling: the read limit exists to bound worst-case memory
	// retention of queued command payloads (issue #2399); it should never
	// silently creep back toward the old 64MB.
	if maxMessageSize > 32*1024*1024 {
		t.Fatalf("maxMessageSize (%d) exceeds 32MB — the read limit bounds worst-case queued-command memory; justify and re-audit before raising it", maxMessageSize)
	}
}
