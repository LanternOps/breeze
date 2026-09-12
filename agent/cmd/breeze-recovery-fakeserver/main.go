// Command breeze-recovery-fakeserver runs the test-only fake recovery
// server (agent/internal/backup/bmr/fakeserver) used by the QEMU
// end-to-end proof (W04b Task 4, agent/recovery-media/e2e/run-qemu.sh).
// NOT a release artifact — excluded from agent/scripts/build-edition.sh.
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/breeze-rmm/agent/internal/backup/bmr/fakeserver"
)

func main() {
	addr := flag.String("addr", "0.0.0.0:18080", "listen address")
	code := flag.String("code", "", "recovery code the console must present (required)")
	snapshotID := flag.String("snapshot-id", "", "snapshot id the minted token's bootstrap points at (required)")
	storeDir := flag.String("store-dir", "", "object store root (required) — see e2e/seed-snapshot.sh")
	progressLog := flag.String("progress-log", "", "path to write the JSON array of posted progress statuses (required)")
	identity := flag.String("identity", "new", "recovery identity: original|new")
	nonce := flag.String("nonce", "", "recovery nonce (required when --identity=original)")
	minHelperVersion := flag.String("min-helper-version", "0.0.0", "BootstrapResponse.MinHelperVersion")
	flag.Parse()

	if *code == "" || *snapshotID == "" || *storeDir == "" || *progressLog == "" {
		log.Fatal("breeze-recovery-fakeserver: --code, --snapshot-id, --store-dir and --progress-log are required")
	}

	srv := fakeserver.New(fakeserver.Config{
		Code:             *code,
		SnapshotID:       *snapshotID,
		StoreDir:         *storeDir,
		ProgressLogPath:  *progressLog,
		Identity:         *identity,
		Nonce:            *nonce,
		MinHelperVersion: *minHelperVersion,
	})

	log.Printf("breeze-recovery-fakeserver: listening on %s (snapshot=%s store=%s)", *addr, *snapshotID, *storeDir)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("breeze-recovery-fakeserver: %v", err)
	}
}
