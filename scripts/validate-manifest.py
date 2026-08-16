#!/usr/bin/env python3
"""Validate the Jellyfin repository manifest and its project-local logo."""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


PLUGIN_FIELDS = (
    "category",
    "guid",
    "name",
    "description",
    "overview",
    "owner",
    "imageUrl",
    "versions",
)
VERSION_FIELDS = (
    "version",
    "changelog",
    "targetAbi",
    "sourceUrl",
    "checksum",
    "timestamp",
)
FOUR_PART_VERSION = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
ABI_VERSION = re.compile(r"^\d+(?:\.\d+){2,3}$")
MD5 = re.compile(r"^[0-9a-fA-F]{32}$")


def fail(message: str) -> None:
    raise ValueError(message)


def require_https(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{field} must be a non-empty string")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        fail(f"{field} must be an absolute HTTPS URL")
    return value


def version_tuple(value: str) -> tuple[int, int, int, int]:
    return tuple(int(part) for part in value.split("."))  # type: ignore[return-value]


def validate_logo(manifest_path: Path, image_url: str) -> None:
    logo_name = Path(urlparse(image_url).path).name
    logo_path = manifest_path.parent / logo_name
    if not logo_path.is_file():
        fail(f"manifest logo is missing: {logo_path}")

    header = logo_path.read_bytes()[:26]
    if len(header) < 26 or header[:8] != b"\x89PNG\r\n\x1a\n":
        fail("manifest logo must be a PNG image")

    width, height = struct.unpack(">II", header[16:24])
    color_type = header[25]
    if width != height or width < 128:
        fail(f"manifest logo must be square and at least 128px (found {width}x{height})")
    if color_type not in (4, 6):
        fail("manifest logo must have an alpha channel")


def validate_manifest(path: Path, allow_empty: bool) -> tuple[str, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or len(data) != 1:
        fail("manifest must contain exactly one plugin entry")

    plugin = data[0]
    if not isinstance(plugin, dict):
        fail("plugin entry must be an object")
    for field in PLUGIN_FIELDS:
        if field not in plugin:
            fail(f"plugin entry is missing {field}")

    try:
        uuid.UUID(str(plugin["guid"]))
    except ValueError as error:
        fail(f"plugin guid is invalid: {error}")

    for field in ("category", "name", "description", "overview", "owner"):
        if not isinstance(plugin[field], str) or not plugin[field].strip():
            fail(f"plugin {field} must be a non-empty string")

    image_url = require_https(plugin["imageUrl"], "plugin imageUrl")
    validate_logo(path, image_url)

    versions = plugin["versions"]
    if not isinstance(versions, list):
        fail("plugin versions must be an array")
    if not versions and not allow_empty:
        fail("plugin versions must contain at least one release")

    seen: set[str] = set()
    parsed_versions: list[tuple[int, int, int, int]] = []
    for index, release in enumerate(versions):
        prefix = f"versions[{index}]"
        if not isinstance(release, dict):
            fail(f"{prefix} must be an object")
        for field in VERSION_FIELDS:
            if field not in release:
                fail(f"{prefix} is missing {field}")

        version = release["version"]
        if not isinstance(version, str) or not FOUR_PART_VERSION.fullmatch(version):
            fail(f"{prefix}.version must contain four numeric parts")
        if version in seen:
            fail(f"duplicate release version: {version}")
        seen.add(version)
        parsed_versions.append(version_tuple(version))

        changelog = release["changelog"]
        if not isinstance(changelog, str) or not changelog.strip():
            fail(f"{prefix}.changelog must be a non-empty string")

        target_abi = release["targetAbi"]
        if not isinstance(target_abi, str) or not ABI_VERSION.fullmatch(target_abi):
            fail(f"{prefix}.targetAbi must contain three or four numeric parts")

        source_url = require_https(release["sourceUrl"], f"{prefix}.sourceUrl")
        if not source_url.lower().endswith(".zip"):
            fail(f"{prefix}.sourceUrl must point to a ZIP archive")

        checksum = release["checksum"]
        if not isinstance(checksum, str) or not MD5.fullmatch(checksum):
            fail(f"{prefix}.checksum must be a 32-character MD5 digest")

        timestamp = release["timestamp"]
        if not isinstance(timestamp, str):
            fail(f"{prefix}.timestamp must be a string")
        try:
            datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError as error:
            fail(f"{prefix}.timestamp is invalid: {error}")

    if parsed_versions != sorted(parsed_versions, reverse=True):
        fail("plugin versions must be ordered newest first")

    return str(plugin["name"]), len(versions)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--allow-empty", action="store_true")
    args = parser.parse_args()

    try:
        name, releases = validate_manifest(args.manifest.resolve(), args.allow_empty)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Manifest validation failed: {error}", file=sys.stderr)
        return 1

    print(f"Manifest valid: {name} ({releases} release{'s' if releases != 1 else ''})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
