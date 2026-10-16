package ipc

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net"
	"testing"
)

// readerConn is a net.Conn whose reads come from a fixed byte slice. Recv only
// ever calls Read, so the embedded nil net.Conn is never touched.
type readerConn struct {
	net.Conn
	r *bytes.Reader
}

func (c *readerConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func newReaderConn(b []byte) *Conn { return NewConn(&readerConn{r: bytes.NewReader(b)}) }

// frame length-prefixes a JSON body the way Send does.
func frame(body []byte) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out, uint32(len(body)))
	copy(out[4:], body)
	return out
}

// FuzzConnRecvRaw feeds arbitrary bytes to the pre-auth receive path. A local
// unprivileged process can write anything to the broker socket before it
// authenticates, so Recv must never panic, and anything it does accept must
// carry a valid HMAC and a positive sequence number.
func FuzzConnRecvRaw(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{0, 0, 0, 0})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff})
	f.Add(frame([]byte(`{}`)))
	f.Add(frame([]byte(`{"id":"a","seq":1,"type":"auth_request","payload":null,"hmac":""}`)))

	f.Fuzz(func(t *testing.T, data []byte) {
		c := newReaderConn(data)
		for i := 0; i < 4; i++ {
			env, err := c.Recv()
			if err != nil {
				return
			}
			if env == nil {
				t.Fatal("Recv returned nil envelope with nil error")
			}
			if env.Seq == 0 {
				t.Fatalf("Recv accepted sequence number 0")
			}
			if env.HMAC != c.computeHMAC(env) {
				t.Fatalf("Recv accepted an envelope whose HMAC does not verify")
			}
		}
	})
}

// FuzzConnRecvReplay builds correctly signed pre-auth frames from fuzzed fields,
// so the fuzzer gets past the HMAC check and exercises sequence handling.
// Properties: a frame is accepted only with seq > 0, and the identical frame
// sent a second time is always rejected as a replay.
func FuzzConnRecvReplay(f *testing.F) {
	f.Add("req-1", uint64(1), "auth_request", []byte(`{"pid":1}`))
	f.Add("", uint64(0), "", []byte(nil))
	f.Add("x", ^uint64(0), "ping", []byte(`null`))

	f.Fuzz(func(t *testing.T, id string, seq uint64, typ string, payload []byte) {
		env := &Envelope{ID: id, Seq: seq, Type: typ}
		if json.Valid(payload) {
			env.Payload = json.RawMessage(payload)
		}
		signer := newReaderConn(nil)
		env.HMAC = signer.computeHMAC(env)
		body, err := json.Marshal(env)
		if err != nil {
			t.Skip()
		}
		one := frame(body)
		c := newReaderConn(append(append([]byte{}, one...), one...))

		got, err := c.Recv()
		if seq == 0 {
			if err == nil {
				t.Fatalf("accepted seq 0")
			}
			return
		}
		if err != nil {
			// JSON round-trip can legitimately change a field (e.g. invalid
			// UTF-8 in id/type is replaced), which breaks the HMAC. Not a bug.
			return
		}
		if got.Seq != seq {
			t.Fatalf("seq changed in transit: sent %d got %d", seq, got.Seq)
		}
		if _, err := c.Recv(); err == nil {
			t.Fatalf("replayed frame with seq %d was accepted", seq)
		}
	})
}
