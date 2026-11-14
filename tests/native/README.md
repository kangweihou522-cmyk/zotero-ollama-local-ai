# Native Zotero smoke test

This test installs the **built XPI through Zotero's actual AddonManager** in a disposable Linux profile. It checks the manifest parser, installation, addon bootstrap, menu and preference registration, the real chrome dialog, native HTTP to a loopback protocol fixture, and actual Zotero tag/Extra/child-note database writes.

The driver is a separate test-only addon. It is not part of the production XPI. All library content is synthetic, the test profile and data directory are newly created, and no user's existing Zotero profile is opened.

Run `python3 scripts/build.py`, then `bash tests/native/run.sh`. The runner downloads Zotero **10.0.8** from the official download endpoint, requires Linux `xvfb-run`, `timeout`, Node.js, Python 3 and GTK runtime libraries, and keeps logs under `$NATIVE_SMOKE_DIR` (default: a temporary-directory location). Set `ZOTERO_BIN` to an existing Linux Zotero executable to skip the download.

The mock speaks Ollama's local API, including streamed NDJSON and model residency, but loads no real model. The native driver also exercises an actual loopback OAuth callback, WebCrypto-signed synthetic identity tokens, native LoginManager persistence, refresh rotation, generated SSE, and logout. OAuth/token/model HTTP responses are injected fixtures, not a real ChatGPT account.

A passing run establishes native host/protocol/storage integration, not Plus entitlement, actual model availability or quality, GPU performance, OCR, or Windows/macOS compatibility. The v0.3.0 candidate passed in [run 43466210779](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/actions/runs/43466210779); see [validation scope](../../docs/VALIDATION.md).

The separate driver's startup intentionally schedules its async test without returning the Promise: Zotero waits for addon startup before announcing that its UI is ready.
