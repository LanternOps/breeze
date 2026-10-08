package clipboard

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Chunking is a transport under the ordinary clipboard messages. A message
// whose JSON is larger than one frame is split into pieces, each sent as
//
//	{"type":"chunk","id":"<transfer>","seq":n,"total":N,"data":"<base64 piece>"}
//
// The receiver concatenates the pieces and handles the result exactly as if it
// had arrived whole. pion's outbound limit is the viewer's advertised
// a=max-message-size (65,535 bytes when unset), so a 2 MiB image never fitted
// in one message (spec gotcha C2).
const (
	// chunkPieceBytes raw bytes become ~43.7 KiB of base64 plus the envelope.
	chunkPieceBytes = 32 * 1024
	// chunkFrameMaxBytes is the most any frame may serialize to.
	chunkFrameMaxBytes = 48 * 1024
	// maxAssembledBytes bounds a reassembled message: an 8 MiB image as
	// base64 is ~10.7 MiB, plus JSON.
	maxAssembledBytes = 12 * 1024 * 1024
	// chunkTransferTimeout drops a transfer the sender abandoned.
	chunkTransferTimeout = 30 * time.Second
)

type chunkFrame struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Seq   int    `json:"seq"`
	Total int    `json:"total"`
	Data  string `json:"data"`
}

func newTransferID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// encodeChunks splits inner into serialized frames for transfer id.
func encodeChunks(id string, inner []byte) ([][]byte, error) {
	if len(inner) > maxAssembledBytes {
		return nil, fmt.Errorf("clipboard message exceeds maximum %d bytes", maxAssembledBytes)
	}
	total := (len(inner) + chunkPieceBytes - 1) / chunkPieceBytes
	if total == 0 {
		total = 1
	}
	frames := make([][]byte, 0, total)
	for seq := 0; seq < total; seq++ {
		start := seq * chunkPieceBytes
		end := start + chunkPieceBytes
		if end > len(inner) {
			end = len(inner)
		}
		raw, err := json.Marshal(chunkFrame{
			Type: "chunk", ID: id, Seq: seq, Total: total,
			Data: base64.StdEncoding.EncodeToString(inner[start:end]),
		})
		if err != nil {
			return nil, err
		}
		frames = append(frames, raw)
	}
	return frames, nil
}

// chunkAssembler rebuilds one transfer at a time. A frame with seq 0 starts a
// new transfer and discards any partial one, so an abandoned transfer costs at
// most one buffer. Frames on the clipboard channel are ordered and reliable,
// so anything out of sequence is an error, not a reordering to repair.
type chunkAssembler struct {
	now     func() time.Time
	id      string
	next    int
	total   int
	buf     []byte
	started time.Time
}

func (a *chunkAssembler) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func (a *chunkAssembler) reset() {
	a.id, a.next, a.total, a.buf = "", 0, 0, nil
}

// add consumes f. It returns the reassembled message and true when f was the
// last piece.
func (a *chunkAssembler) add(f chunkFrame) ([]byte, bool, error) {
	if f.ID == "" || f.Total < 1 || f.Total > maxAssembledBytes/chunkPieceBytes+1 || f.Seq < 0 || f.Seq >= f.Total {
		a.reset()
		return nil, false, errors.New("invalid clipboard chunk header")
	}
	if f.Seq == 0 {
		a.reset()
		a.id, a.total, a.started = f.ID, f.Total, a.clock()
	} else if f.ID != a.id {
		a.reset()
		return nil, false, errors.New("clipboard chunk for an unknown transfer")
	}
	if a.clock().Sub(a.started) > chunkTransferTimeout {
		a.reset()
		return nil, false, errors.New("clipboard transfer timed out")
	}
	if f.Seq != a.next || f.Total != a.total {
		a.reset()
		return nil, false, errors.New("clipboard chunk out of sequence")
	}
	piece, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil {
		a.reset()
		return nil, false, fmt.Errorf("clipboard chunk data: %w", err)
	}
	if len(piece) > chunkPieceBytes || len(a.buf)+len(piece) > maxAssembledBytes {
		a.reset()
		return nil, false, errors.New("clipboard chunk exceeds size limits")
	}
	a.buf = append(a.buf, piece...)
	a.next++
	if a.next < a.total {
		return nil, false, nil
	}
	out := a.buf
	a.reset()
	return out, true, nil
}
