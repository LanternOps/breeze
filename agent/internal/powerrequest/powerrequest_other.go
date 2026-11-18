//go:build !windows

package powerrequest

func holdSystemAwake(string) (func(), error) {
	return func() {}, nil
}
