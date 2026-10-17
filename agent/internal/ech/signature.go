package ech

import (
	"bytes"
	"crypto/tls"
	"errors"
)

// IsFilterSignature reports whether err is the fingerprint of an ISP gateway
// filter that hijacked the HTTPS connection by SNI: the filter answers the TLS
// ClientHello with a plaintext HTTP response (e.g. a 302 to a warning page), so
// Go's crypto/tls fails with a tls.RecordHeaderError whose first five bytes are
// "HTTP/" instead of a TLS record header.
func IsFilterSignature(err error) bool {
	var rhe tls.RecordHeaderError
	return errors.As(err, &rhe) && bytes.HasPrefix(rhe.RecordHeader[:], []byte("HTTP/"))
}
