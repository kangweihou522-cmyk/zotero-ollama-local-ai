# Native Zotero smoke test

This test installs the **built XPI through Zotero's actual AddonManager** in a disposable Linux profile. It checks the manifest parser, installation, addon bootstrap, menu and preference registration, the real chrome dialog, native HTTP to a loopback protocol fixture, and actual Zotero tag/Extra/child-note database writes.

The driver is a separate test-only addon. It is not part of the production XPI. All library content is synthetic, the test profile and data directory are newly created, and no user's existing Zotero profile is opened.

Run `python3 scripts/build.py`, then `bash tests/native/run.sh`. The runner downloads Zotero **10.0.8** from the official download endpoint, requires Linux `xvfb-run`, `timeout`, Node.js, Python 3 and GTK runtime libraries, and keeps logs under `$NATIVE_SMOKE_DIR` (default: a temporary-directory location). Set `ZOTERO_BIN` to an existing Linux Zotero executable to skip the download.

The mock speaks Ollama's local API but loads no real model. A passing run establishes native host/protocol/storage integration, not model quality, OCR, or Windows/macOS compatibility. Until the GitHub Actions job has actually completed successfully, this is an implemented smoke test rather than evidence of a passing native installation.

The separate driver's startup intentionally schedules its async test without returning the Promise: Zotero waits for addon startup before announcing that its UI is ready.
