# Breeze Agent vs NinjaOne Agent - Performance Comparison

**Date:** 2026-02-08
**System:** Windows, both agents running simultaneously

## Binary Size

| | **Breeze** | **NinjaOne** |
|---|---|---|
| Main executable | **20.2 MB** | 48.2 MB |
| Supporting binaries | — | 37.1 MB (patcher) + 18.3 MB (njdialog) + 11.2 MB (WPM) |
| Total install footprint | **~20 MB** | **206 MB** (17 files, incl. old versions) |

Breeze is ~10x smaller on disk.

## Memory (Live Snapshot)

| Process | Working Set | Private Bytes | Handles | Threads |
|---|---|---|---|---|
| **breeze-agent** | **236 MB** | 234 MB | 530 | 32 |
| NinjaRMMAgent | 61 MB | 48 MB | 1,021 | 113 |
| NinjaRMMAgentPatcher | 20 MB | 7 MB | 316 | 23 |
| ncstreamer (supervisor) | 38 MB | 8 MB | 429 | 8 |
| ncstreamer (session) | 181 MB | 285 MB | 678 | 31 |
| **Ninja total (4 procs)** | **300 MB** | **348 MB** | **2,444** | **175** |

## Key Observations

### Breeze advantages
- **Disk footprint** (20 MB vs 206 MB) — single static Go binary, no dependencies
- **Handle count** (530 vs 2,444) — much lighter OS resource usage
- **Thread count** (32 vs 175) — Go's goroutine model is far more efficient
- **Process count** (1 vs 4) — single process vs multi-process architecture

### Ninja advantages
- **Idle working set** per core process (61 MB vs 236 MB)

### Notes
- The 236 MB working set on Breeze is likely the desktop streaming pipeline holding frame buffers in memory. For an idle agent without streaming, Go agents typically sit at 15-30 MB.
- Lazily allocating screen capture buffers (only when a remote session is active) and releasing them afterward could drop idle memory to the 20-30 MB range, making Breeze lighter than Ninja in every metric.
