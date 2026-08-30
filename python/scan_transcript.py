#!/usr/bin/env python3
"""Compares text against every identifier value in the dataset."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

#: Values shorter than this are skipped. A one-character arm code or a two-digit site
#: number occurs in ordinary prose constantly; treating those as leaks would make the
#: check fire on every run and get it switched off.
MIN_VALUE_LENGTH = 5


def scan(text: str, frame: pd.DataFrame, columns: list[str]) -> dict[str, object]:
    matches: list[dict[str, object]] = []
    checked = 0

    for column in columns:
        if column not in frame.columns:
            continue

        hits = 0
        distinct = 0
        for value in frame[column].dropna().unique():
            candidate = str(value).strip()
            if len(candidate) < MIN_VALUE_LENGTH:
                continue
            distinct += 1
            if candidate in text:
                hits += 1

        checked += distinct
        if hits:
            matches.append({"column": column, "distinct_values_found": hits})

    return {
        "schema_version": 1,
        "check": "transcript",
        "columns_checked": [c for c in columns if c in frame.columns],
        "values_compared": checked,
        "text_length": len(text),
        "matches": matches,
        "leaked": bool(matches),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compare text against dataset identifiers.")
    parser.add_argument("text_path", type=Path, help="the text to check")
    parser.add_argument("data_path", type=Path, help="the dataset to check it against")
    parser.add_argument(
        "--columns",
        required=True,
        help=(
            "comma-separated identifier columns to compare against. Pass the columns "
            "the classifier flagged, not every column: an analysis category such as "
            "arm=treatment is what the pipeline exists to discuss, and matching on it "
            "would report a leak on every clean run."
        ),
    )
    parser.add_argument("--run-id", default=None)
    args = parser.parse_args(argv)

    frame = pd.read_csv(args.data_path, dtype=str, keep_default_na=False)
    columns = [c.strip() for c in args.columns.split(",") if c.strip()]

    text = args.text_path.read_text(encoding="utf-8", errors="replace")
    result = scan(text, frame, columns)
    result["run_id"] = args.run_id

    print(json.dumps(result, indent=2))
    return 1 if result["leaked"] else 0


if __name__ == "__main__":
    sys.exit(main())
