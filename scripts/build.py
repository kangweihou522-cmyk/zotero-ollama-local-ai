#!/usr/bin/env python3
"""Build deterministic Zotero XPI and source archives using only stdlib."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


ROOT = Path(__file__).resolve().parents[1]
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def source_files(directory: Path):
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symbolic links are not packaged: {path}")
        if not path.is_file():
            continue
        if any(part.startswith(".") or part in {"__pycache__", "node_modules", "dist", "work"}
               for part in path.relative_to(directory).parts):
            continue
        if path.name in {".DS_Store"} or path.suffix in {".pyc", ".pyo"}:
            continue
        yield path


def archive(destination: Path, files):
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for name, path in sorted(files, key=lambda pair: pair[0]):
            entry = zipfile.ZipInfo(name, FIXED_TIME)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            out.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(destination) as check:
        bad = check.testzip()
        if bad:
            raise ValueError(f"Corrupt archive member: {bad}")
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    print(f"{destination.name}  {destination.stat().st_size} bytes  sha256:{digest}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist", help="Destination directory")
    args = parser.parse_args()
    addon = ROOT / "addon"
    manifest = json.loads((addon / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or package.get("version") != version:
        raise ValueError("Manifest and package.json must contain the same semantic version")
    target = manifest.get("applications", {}).get("zotero", {})
    if (manifest.get("manifest_version") != 2
            or target.get("id") != "ollama-local-ai@local.tools"
            or target.get("strict_min_version") != "10.0"
            or target.get("strict_max_version") != "10.0.*"):
        raise ValueError("Unexpected Zotero manifest identity or compatibility target")
    for required in ["bootstrap.js", "content/core.js", "content/zotero-adapter.js",
                     "content/main.js", "content/dialog.xhtml", "content/dialog.js",
                     "content/dialog.css", "content/preferences.xhtml", "content/preferences.js",
                     "content/icon.svg", "locale/en-US/ollama-local-ai.ftl", "locale/zh-CN/ollama-local-ai.ftl"]:
        if not (addon / required).is_file():
            raise ValueError(f"Missing addon resource: {required}")
    destination = args.output.expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    addon_files = list(source_files(addon))
    archive(destination / f"ollama-local-ai-{version}.xpi",
            [(path.relative_to(addon).as_posix(), path) for path in addon_files])
    sources = list(addon_files)
    for directory in ["tests", "scripts", "docs"]:
        sources.extend(source_files(ROOT / directory))
    sources.extend(ROOT / filename for filename in ["README.md", "LICENSE", "package.json", ".gitignore"])
    archive(destination / f"ollama-local-ai-{version}-source.zip",
            [(path.relative_to(ROOT).as_posix(), path) for path in sources])


if __name__ == "__main__":
    main()
