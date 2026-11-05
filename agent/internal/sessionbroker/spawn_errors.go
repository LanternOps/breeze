package sessionbroker

import "errors"

// ErrBinaryMissing: the spawn target does not exist on disk. Returned by the
// Windows session spawner BEFORE any token acquisition or cmd.exe launch, so a
// missing helper never reports a bogus "spawned" success (#6872).
var ErrBinaryMissing = errors.New("spawn target does not exist")

// ErrNoInteractiveUser: nobody is signed in to the target session, so there is
// no user token to launch under (#10379). The user-only spawn path
// (SpawnProcessInSessionWithArgs, AcquireInteractiveUserToken) returns it
// instead of falling back to SYSTEM: a UI app launched as SYSTEM into the
// logon-screen session cannot start. Callers treat it as "wait for a user",
// not as a launch failure.
var ErrNoInteractiveUser = errors.New("no signed-in user in the session")
