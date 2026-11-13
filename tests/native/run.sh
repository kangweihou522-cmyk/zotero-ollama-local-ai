#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke_dir="${NATIVE_SMOKE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zotero-local-ai-native-smoke}"
zotero_version="10.0.8"
mkdir -p "$smoke_dir"
profile_dir="$(mktemp -d "$smoke_dir/profile.XXXXXX")"
runtime_dir="$smoke_dir/runtime"
mkdir -p "$runtime_dir" "$profile_dir/extensions" "$profile_dir/data"
printf '%s\n' "$profile_dir" > "$smoke_dir/profile-path.txt"

if [[ -z "${ZOTERO_BIN:-}" ]]; then
  curl --fail --location --retry 2 --max-time 180 \
    "https://www.zotero.org/download/client/dl?channel=release&platform=linux-x86_64&version=$zotero_version" \
    --output "$smoke_dir/zotero-runtime.tar" \
    > "$smoke_dir/download.log" 2>&1
  tar -xf "$smoke_dir/zotero-runtime.tar" -C "$runtime_dir"
  zotero_bin="$(find "$runtime_dir" -maxdepth 3 -type f -name zotero -print -quit)"
else
  zotero_bin="$ZOTERO_BIN"
fi
if [[ ! -x "$zotero_bin" ]]; then
  printf '%s\n' "A Zotero $zotero_version executable was not found: $zotero_bin" >&2
  exit 1
fi
command -v xvfb-run > /dev/null
command -v timeout > /dev/null

python3 - "$repo_dir" "$profile_dir" <<'PY'
from pathlib import Path
import json
import shutil
import sys

repo, profile = map(Path, sys.argv[1:])
manifest = json.loads((repo / 'addon/manifest.json').read_text())
package = repo / 'dist' / f"ollama-local-ai-{manifest['version']}.xpi"
if not package.is_file():
    raise SystemExit(f'Missing built installer: {package}; run python3 scripts/build.py first')
shutil.copyfile(package, profile / 'ollama-local-ai.xpi')
driver = repo / 'tests/native/driver'
driver_manifest = json.loads((driver / 'manifest.json').read_text())
shutil.copytree(driver, profile / 'extensions' / driver_manifest['applications']['zotero']['id'])
prefs = {
    'app.update.enabled': False,
    'app.update.auto': False,
    'extensions.update.enabled': False,
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'extensions.zotero.useDataDir': True,
    'extensions.zotero.dataDir': str(profile / 'data'),
    'extensions.zotero.firstRun.skipFirefoxProfileAccessCheck': True,
    'extensions.zotero.firstRunGuidance': False,
    'extensions.zotero.firstRun2': False,
    'extensions.zotero.sync.autoSync': False,
    'extensions.zotero.automaticScraperUpdates': False,
    'extensions.zotero.reportTranslationFailure': False,
    'extensions.zotero.backup.numBackups': 0,
    'extensions.zoteroMacWordIntegration.skipInstallation': True,
    'extensions.zoteroWinWordIntegration.skipInstallation': True,
    'extensions.zoteroOpenOfficeIntegration.skipInstallation': True,
    'extensions.zotero.debug.log': True,
    'extensions.zotero.debug.level': 5,
    'browser.shell.checkDefaultBrowser': False,
}
(profile / 'prefs.js').write_text(''.join(
    'user_pref(' + json.dumps(key) + ', ' + json.dumps(value) + ');\n'
    for key, value in prefs.items()
))
PY

node "$repo_dir/tests/native/mock-ollama.cjs" > "$smoke_dir/mock-ollama.log" 2>&1 &
mock_pid=$!
cleanup() { kill "$mock_pid" 2>/dev/null || true; }
trap cleanup EXIT
fixture_ready=false
for attempt in {1..30}; do
  if curl --fail --silent --max-time 1 http://127.0.0.1:11435/health > /dev/null; then
    fixture_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$fixture_ready" != true ]]; then
  cat "$smoke_dir/mock-ollama.log" >&2
  exit 1
fi

set +e
MOZ_NO_REMOTE=1 NO_EM_RESTART=1 timeout --kill-after=10s 180s \
  xvfb-run -a "$zotero_bin" -no-remote -profile "$profile_dir" -ZoteroDebugText \
  > "$smoke_dir/zotero.log" 2>&1
zotero_exit=$?
set -e
if [[ -f "$profile_dir/native-smoke.json" ]]; then
  cp "$profile_dir/native-smoke.json" "$smoke_dir/result.json"
fi
python3 - "$smoke_dir" "$zotero_exit" <<'PY'
from pathlib import Path
import json
import sys

directory = Path(sys.argv[1])
exit_code = int(sys.argv[2])
result = directory / 'result.json'
if not result.exists():
    print('Native Zotero did not produce a smoke report.', file=sys.stderr)
    print((directory / 'zotero.log').read_text(errors='replace')[-16000:], file=sys.stderr)
    raise SystemExit(exit_code or 1)
report = json.loads(result.read_text())
print(json.dumps(report, indent=2))
if exit_code or report.get('success') is not True:
    print((directory / 'zotero.log').read_text(errors='replace')[-16000:], file=sys.stderr)
    raise SystemExit(exit_code or 1)
PY
