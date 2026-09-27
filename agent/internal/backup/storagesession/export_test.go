package storagesession

// AllowLoopbackHTTPForTest permits plain http to loopback hosts until the
// returned restore func runs.
func AllowLoopbackHTTPForTest() (restore func()) {
	prev := allowLoopbackHTTP
	allowLoopbackHTTP = true
	return func() { allowLoopbackHTTP = prev }
}
