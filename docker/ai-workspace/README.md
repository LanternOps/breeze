# Breeze analysis runtime

A build-time provisioned Vercel Sandbox image with Python 3.13, Node 24, Bash,
pandas, numpy, openpyxl, python-docx, ReportLab, pypdf, pdfplumber, Poppler, DejaVu fonts, jq, ripgrep and sqlite3. No packages are
installed during an analysis run. Breeze still creates each sandbox with
`networkPolicy: 'deny-all'` and `persistent: false`.

## Build and verify

From the repository root:

```sh
docker buildx build --platform linux/amd64 --load \
  -t breeze-ai-workspace:analysis-v1 docker/ai-workspace
docker run --rm --platform linux/amd64 --network none \
  breeze-ai-workspace:analysis-v1 python3 /opt/breeze-runtime/smoke.py
```

CI builds this image on code changes and runs the smoke test as the image’s
unprivileged user with networking disabled. `CI Success` requires this check;
it does not publish images or use Vercel credentials.

The smoke test calculates a known total and writes/reopens XLSX, DOCX and PDF files, extracts PDF text with two libraries,
and renders the PDF with Poppler.
The build also checks Node and the command-line utilities. Vercel requires
linux/amd64 images, including when building from an ARM Mac. Runtime commands
use `python3` directly; no virtualenv activation or runtime environment override
is needed. The image uses an unprivileged user with a writable `/work` directory.

## Publish and configure

The repository is private by default. Authenticate to the desired Vercel project
using a token with Container Registry access; sandbox-only credentials may not
have that access. Never put tokens in Docker build arguments or the build context.

```sh
vercel vcr login docker --project <project>
vercel vcr build docker docker/ai-workspace breeze-ai-workspace:analysis-v1 \
  --project <project> --push
vercel vcr tag inspect breeze-ai-workspace analysis-v1 --project <project>
```

Wait for the image to be Ready in VCR. Set the API **and worker** environment to
an immutable reference using the digest from the published image:

```dotenv
IS_HOSTED=true
BREEZE_AI_AGENTS_ENABLED=true
BREEZE_AI_WORKSPACE_ENABLED=true
AI_WORKSPACE_BACKEND=vercel
VERCEL_SANDBOX_TOKEN=<sandbox-token>
VERCEL_TEAM_ID=<team-id>
VERCEL_PROJECT_ID=<project-id>
VERCEL_SANDBOX_IMAGE=breeze-ai-workspace@sha256:<published-digest>
```

The name above resolves in the project selected by `VERCEL_PROJECT_ID`. Recreate
API/worker containers after updating the environment. The compose templates map
these settings; custom deployments must map them too. Optional region overrides
and the compute price multiplier are also mapped. Configure the artifact storage
settings in `.env.example` before enabling workspace runs. An unset or empty value retains
the existing universal image for compatibility. Each new workspace records the exact image reference used by the provider in
`runtimeImage` on its run trace. Digest-pinned references identify immutable bytes;
a mutable tag or the universal default records only the selected reference, not a
resolved digest. Legacy rows remain null. There is no fallback to that base
image if an explicitly configured custom image fails to start.

Use a configured AI agent with workspace tool access to run an analysis that
uses pandas to total values, writes XLSX with openpyxl and DOCX with python-docx,
reopens both to verify their contents, and collects them as artifacts. Download
both files from the run UI. Chat-initiated background launches are disabled
pending delegated authorization. For PDFs, configure the agent to create a report
with ReportLab, reopen it with pypdf/pdfplumber, render it with pdftoppm, and collect
the PDF plus a preview PNG. Scanned PDFs still require an OCR dependency;
LibreOffice document-to-PDF conversion is not included.

## Dependency updates

Base images are pinned by OCI digest. Python direct dependencies are in
`requirements.in`; `requirements.lock` pins every transitive dependency and wheel
hash for CPython 3.13/Linux amd64. Regenerate in the same pinned Python image:

```sh
# Use an empty wheel directory to avoid retaining old versions.
docker run --rm --platform linux/amd64 \
  -v "$PWD/docker/ai-workspace:/output" \
  python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e \
  python -m pip download --only-binary=:all: \
  -r /output/requirements.in -d /output/wheels
python3 docker/ai-workspace/lock-wheels.py
```

Review version and hash changes, rebuild, and repeat the offline smoke test before
publishing under a new tag. Debian utility packages receive the versions available
in the configured Bookworm repositories at build time; the final image digest
pins those installed bytes. Refresh base digests and rebuild for security updates.

Sources: [Vercel images](https://vercel.com/docs/sandbox/concepts/images),
[Vercel Container Registry](https://vercel.com/docs/container-registry).
