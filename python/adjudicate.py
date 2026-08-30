#!/usr/bin/env python3
"""Decides whether identifier-shaped strings came from the data."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def adjudicate(candidates: list[str], data_paths: list[Path]) -> dict[str, object]:
    corpus = ""
    present: list[Path] = []
    for path in data_paths:
        if path.exists():
            corpus += path.read_text(encoding="utf-8", errors="replace")
            present.append(path)

    findings = [
        {"candidate_sha256_prefix": _fingerprint(c), "occurrences": corpus.count(c)}
        for c in candidates
    ]

    return {
        "schema_version": 1,
        "check": "adjudicate",
        "files_searched": [str(p) for p in present],
        "candidates": len(candidates),
        "findings": findings,
        "leaked": any(f["occurrences"] > 0 for f in findings),
    }


def _fingerprint(value: str) -> str:
    """Identify a candidate without echoing it — the output is model-visible."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Adjudicate suspected PII leaks.")
    parser.add_argument("candidates_file", type=Path, help="JSON array of strings")
    parser.add_argument("data_paths", nargs="+", type=Path)
    args = parser.parse_args(argv)

    candidates = json.loads(args.candidates_file.read_text(encoding="utf-8"))
    if not isinstance(candidates, list):
        raise SystemExit("candidates file must contain a JSON array of strings")

    result = adjudicate([str(c) for c in candidates], args.data_paths)
    print(json.dumps(result, indent=2))
    return 1 if result["leaked"] else 0


if __name__ == "__main__":
    sys.exit(main())
