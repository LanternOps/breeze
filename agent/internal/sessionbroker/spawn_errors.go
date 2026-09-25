package sessionbroker

import "errors"

// ErrBinaryMissing: the spawn target does not exist on disk. Returned by the
// Windows session spawner BEFORE any token acquisition or cmd.exe launch, so a
// missing helper never reports a bogus "spawned" success (#6872).
var ErrBinaryMissing = errors.New("spawn target does not exist")
