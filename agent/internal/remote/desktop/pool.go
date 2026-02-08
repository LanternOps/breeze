package desktop

import (
	"bytes"
	"image"
	"sync"
)

// bufferPool pools bytes.Buffer instances for JPEG encoding.
var bufferPool = sync.Pool{
	New: func() any {
		return bytes.NewBuffer(make([]byte, 0, 64*1024))
	},
}

func getBuffer() *bytes.Buffer {
	buf := bufferPool.Get().(*bytes.Buffer)
	buf.Reset()
	return buf
}

func putBuffer(buf *bytes.Buffer) {
	if buf.Cap() > 512*1024 {
		return // don't pool oversized buffers
	}
	bufferPool.Put(buf)
}

// imagePool pools *image.RGBA instances for a fixed resolution.
// Streaming sessions use a consistent resolution, so a simple pool works well.
type imagePool struct {
	pool sync.Pool
	w, h int
	mu   sync.Mutex
}

func (p *imagePool) Get(w, h int) *image.RGBA {
	p.mu.Lock()
	if p.w == w && p.h == h {
		p.mu.Unlock()
		if v := p.pool.Get(); v != nil {
			return v.(*image.RGBA)
		}
		return image.NewRGBA(image.Rect(0, 0, w, h))
	}
	// Resolution changed — reset pool
	p.w = w
	p.h = h
	p.pool = sync.Pool{}
	p.mu.Unlock()
	return image.NewRGBA(image.Rect(0, 0, w, h))
}

func (p *imagePool) Put(img *image.RGBA) {
	b := img.Bounds()
	p.mu.Lock()
	match := p.w == b.Dx() && p.h == b.Dy()
	p.mu.Unlock()
	if match {
		p.pool.Put(img)
	}
}

var (
	captureImagePool imagePool
	scaledImagePool  imagePool
)
