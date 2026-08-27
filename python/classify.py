#!/usr/bin/env python3
"""Schema-only PII classification, run inside the TrueForge sandbox.

Reads the raw CSV, runs pattern detectors over every value, and emits a verdict: per
column its name, dtype, populated count, detected identifier type and match rate. The
values themselves never leave this process.

`example` is `None` at the point of construction, not blanked before output, so there
is no code path that can assign a value to it. `assert_no_values_leaked` re-reads the
rendered JSON as a backstop.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

#: Set below 1.0 because real exports have dirty cells: a column where half the
#: values are SSN-shaped is an SSN column with data-quality problems.
MATCH_THRESHOLD = 0.5

#: Fraction of distinct values above which an id-shaped column is treated as a direct
#: participant identifier rather than a shared code.
UNIQUENESS_THRESHOLD = 0.95

#: Short values like "Y" and "1" appear in the verdict as ordinary digits, so the
#: backstop skips them rather than firing on every run.
MIN_LEAK_CHECK_LENGTH = 5


@dataclass(frozen=True)
class Detector:
    """A named identifier pattern, matched against whole (stripped) cell values."""

    pii_type: str
    pattern: re.Pattern[str]


# Anchored whole-value patterns, so prose containing a digit run does not match.
DETECTORS: tuple[Detector, ...] = (
    Detector("ssn", re.compile(r"^\d{3}-\d{2}-\d{4}$")),
    Detector("email", re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")),
    Detector(
        "phone",
        re.compile(r"^\+?1?[\s.\-]*\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}$"),
    ),
    Detector(
        "dob",
        re.compile(
            r"^(?:"
            r"\d{4}-\d{2}-\d{2}"  # 1981-12-07
            r"|\d{1,2}/\d{1,2}/\d{4}"  # 12/07/1981
            r"|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}"  # 7 Dec 1981
            r"|[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}"  # Dec 7, 1981
            r")$"
        ),
    ),
    Detector("mrn", re.compile(r"^[A-Za-z]{2,4}\d{5,10}$")),
    # A per-participant study number is a direct identifier under HIPAA Safe Harbor
    # even though it carries no personal detail: it re-links every row to one person.
    Detector("study_id", re.compile(r"^[A-Za-z]{2,10}[-_]\d{3,10}$")),
    # House number, then something, then a two-letter state and a ZIP.
    Detector(
        "address",
        re.compile(r"^\d+\s+.+,\s*.+,\s*[A-Za-z]{2}\s+\d{5}$"),
    ),
    # Loosest detector, so it goes last.
    Detector(
        "name",
        re.compile(r"^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*)+$"),
    ),
)


def classify_series(values: pd.Series) -> tuple[str | None, float]:
    """Best-matching PII type for a column and its match rate.

    Only populated values count toward the denominator.
    """
    populated = [str(v).strip() for v in values.dropna() if str(v).strip() != ""]
    if not populated:
        return None, 0.0

    best_type: str | None = None
    best_rate = 0.0

    for detector in DETECTORS:
        matches = sum(1 for value in populated if detector.pattern.match(value))
        rate = matches / len(populated)
        if rate > best_rate:
            best_type, best_rate = detector.pii_type, rate

    if best_rate < MATCH_THRESHOLD:
        return None, best_rate

    # A study-id shape only identifies a participant when it is near-unique per row.
    # A shared code such as a site or cohort label is not a direct identifier.
    if best_type == "study_id":
        distinct = len(set(populated))
        if distinct / len(populated) < UNIQUENESS_THRESHOLD:
            return None, best_rate

    return best_type, best_rate


def build_verdict(
    frame: pd.DataFrame,
    dtypes: dict[str, str] | None = None,
    run_id: str | None = None,
) -> dict[str, object]:
    """Build the model-visible verdict: names, counts, dtypes and rates only.

    `frame` is read as strings so the detectors see the file as written; `dtypes`
    carries pandas' inferred types separately, because reporting `object` for every
    column would be a schema the downstream scrub cannot plan against.
    """
    columns: list[dict[str, object]] = []

    for name in frame.columns:
        series = frame[name]
        populated = int(series.apply(lambda v: str(v).strip() != "" and pd.notna(v)).sum())
        pii_type, match_rate = classify_series(series)

        columns.append(
            {
                "name": str(name),
                "dtype": (dtypes or {}).get(str(name), str(series.dtype)),
                "populated": populated,
                "blank": int(len(series) - populated),
                "pii_type": pii_type,
                "match_rate": round(match_rate, 4),
                "example": None,
            }
        )

    return {
        "schema_version": 1,
        "run_id": run_id,
        "row_count": int(len(frame)),
        "column_count": int(len(frame.columns)),
        "pii_columns": [c["name"] for c in columns if c["pii_type"] is not None],
        "columns": columns,
    }


def metadata_strings(frame: pd.DataFrame, verdict: dict[str, object]) -> set[str]:
    """Strings the verdict is *supposed* to contain: schema, dtypes, detector labels.

    A cell whose value happens to equal one of these — a `site` of "address", say —
    would otherwise trip the backstop on every run and get it switched off.
    """
    out = {str(c) for c in frame.columns}
    out |= {d.pii_type for d in DETECTORS}
    out |= {str(c.get("dtype")) for c in verdict.get("columns", [])}  # type: ignore[union-attr]
    out |= {"schema_version", "row_count", "column_count", "pii_columns", "columns",
            "name", "dtype", "populated", "blank", "pii_type", "match_rate", "example", "run_id"}
    return out


def assert_no_values_leaked(
    rendered: str, frame: pd.DataFrame, allowed: set[str] | None = None
) -> None:
    """Fail if any cell value from the dataframe appears in the rendered verdict."""
    allowed = allowed or set()
    for column in frame.columns:
        for value in frame[column].dropna().unique():
            text = str(value).strip()
            if len(text) < MIN_LEAK_CHECK_LENGTH or text in allowed:
                continue
            if text in rendered:
                raise AssertionError(
                    f"classify.py would have leaked a value from column {column!r} "
                    f"({len(text)} chars) into its output. Refusing to print."
                )


def classify_csv(path: Path, run_id: str | None = None) -> dict[str, object]:
    """Load a CSV and return its verdict, with the leak backstop applied."""
    # keep_default_na=False so counts describe the file as written, not as parsed.
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    inferred = pd.read_csv(path)
    dtypes = {str(c): str(inferred[c].dtype) for c in inferred.columns}

    verdict = build_verdict(frame, dtypes, run_id)

    rendered = json.dumps(verdict, indent=2)
    assert_no_values_leaked(rendered, frame, metadata_strings(frame, verdict))

    return verdict


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Schema-only PII classification.")
    parser.add_argument("csv_path", type=Path, help="raw CSV inside the sandbox")
    parser.add_argument("--run-id", default=None, help="binds the verdict to one run")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="also write the verdict here (the printed copy is what the model sees)",
    )
    args = parser.parse_args(argv)

    verdict = classify_csv(args.csv_path, args.run_id)
    rendered = json.dumps(verdict, indent=2)

    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n", encoding="utf-8")

    print(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
