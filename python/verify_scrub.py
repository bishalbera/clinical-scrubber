#!/usr/bin/env python3
"""Check that a scrubbed dataset is actually scrubbed, inside the sandbox.

The Compliance subagent authors its own `scrub.py`, so nothing about the result is
guaranteed by construction. This re-reads the output and reports whether identifiers
survived, in the same shape as `classify.py`: verdicts and counts, never values.

The canary check is the sharp one. `.canary.json` holds values the model has never
seen; if either appears anywhere in the scrubbed file, the scrub left a real patient
identifier behind. Only the boolean crosses back.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from classify import classify_series

#: Column kinds that must not survive a scrub in any form.
DISALLOWED_PII_TYPES = frozenset(
    {"ssn", "name", "email", "phone", "address", "dob", "mrn", "study_id"}
)


def surviving_identifiers(frame: pd.DataFrame) -> list[dict[str, object]]:
    """Columns in the scrubbed frame that still match an identifier pattern."""
    survivors: list[dict[str, object]] = []
    for name in frame.columns:
        pii_type, match_rate = classify_series(frame[name])
        if pii_type in DISALLOWED_PII_TYPES:
            survivors.append(
                {"name": str(name), "pii_type": pii_type, "match_rate": round(match_rate, 4)}
            )
    return survivors


def canary_survived(scrubbed_text: str, canary: dict[str, object]) -> bool:
    values = [canary.get("ssn"), canary.get("name")]
    return any(isinstance(v, str) and v and v in scrubbed_text for v in values)


def verify(
    scrubbed_path: Path, canary_path: Path | None, run_id: str | None = None
) -> dict[str, object]:
    frame = pd.read_csv(scrubbed_path, dtype=str, keep_default_na=False)
    survivors = surviving_identifiers(frame)

    result: dict[str, object] = {
        "schema_version": 1,
        "check": "scrub",
        "row_count": int(len(frame)),
        "columns": [str(c) for c in frame.columns],
        "surviving_identifier_columns": survivors,
        "canary_present": None,
        "run_id": run_id,
        "passed": len(survivors) == 0,
    }

    if canary_path is not None:
        # Asking for the canary check and not getting it must fail. Otherwise deleting
        # the file silently disables the sharpest check in the pipeline while the
        # verifier still reports a pass.
        if not canary_path.exists():
            result["passed"] = False
            result["error"] = f"canary file not found: {canary_path}"
            return result
        try:
            canary = json.loads(canary_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            result["passed"] = False
            result["error"] = f"canary file is not valid JSON: {exc.msg}"
            return result
        if not isinstance(canary, dict) or not canary.get("ssn") or not canary.get("name"):
            result["passed"] = False
            result["error"] = "canary file is missing ssn or name"
            return result

        present = canary_survived(scrubbed_path.read_text(encoding="utf-8"), canary)
        result["canary_present"] = present
        result["passed"] = bool(result["passed"] and not present)

    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify a scrubbed dataset.")
    parser.add_argument("scrubbed_path", type=Path)
    parser.add_argument("--canary", type=Path, default=None)
    parser.add_argument("--run-id", default=None, help="binds the result to one run")
    args = parser.parse_args(argv)

    result = verify(args.scrubbed_path, args.canary, args.run_id)
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
