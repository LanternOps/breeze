# macOS uninstall artifact implementation plan

1. Verify fresh main and all-state PR coverage; inspect the package payload and all
   three supported uninstall entry paths. Preserve existing data/ack policies.
2. Implement fixed embedded cleanup functions, all current launchd domains,
   package file/receipt removal, and propagated cleanup failures.
3. Connect service CLI and detached self-uninstall; synchronize public/API scripts.
4. Prove installer artifact coverage and preserved files with isolated executable
   fixtures; test optional remote config deletion and delayed ordering. Run Go
   race tests, API script tests, typecheck and required CI with bounded concurrency.
5. Obtain independent six-aspect exact-head review; publish a draft referencing
   #4060/RMM-QA-184, with candidate and full-finding closure explicitly outstanding.
