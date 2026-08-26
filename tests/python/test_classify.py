"""Tests for schema-only PII classification: that the detectors are right, and
that no code path puts a cell value into the verdict.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

import classify
import gen_data

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED = 909


@pytest.fixture
def raw_csv(tmp_path: Path):
    records, canary_index, canary = gen_data.generate_trial(rows=200, seed=SEED)
    path = tmp_path / "trial_raw.csv"
    gen_data.write_csv(path, records)
    return path, canary


@pytest.fixture
def verdict(raw_csv):
    path, _ = raw_csv
    return classify.classify_csv(path)


def column(verdict: dict, name: str) -> dict:
    return next(c for c in verdict["columns"] if c["name"] == name)


# --- detectors ---


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("ssn", "ssn"),
        ("email", "email"),
        ("phone", "phone"),
        ("dob", "dob"),
        ("mrn", "mrn"),
        ("address", "address"),
        ("patient_name", "name"),
    ],
)
def test_identifies_pii_columns(verdict, name, expected):
    assert column(verdict, name)["pii_type"] == expected


@pytest.mark.parametrize("name", ["baseline", "followup", "outcome_measure", "adverse_event"])
def test_analysis_columns_are_not_flagged(verdict, name):
    """Flagging the outcome column would produce a useless dataset."""
    assert column(verdict, name)["pii_type"] is None


def test_site_and_arm_are_not_flagged_as_names(verdict):
    """Single-token categoricals must not trip the name detector."""
    assert column(verdict, "site")["pii_type"] is None
    assert column(verdict, "arm")["pii_type"] is None


def test_pii_columns_summary_matches_per_column_verdicts(verdict):
    expected = {c["name"] for c in verdict["columns"] if c["pii_type"] is not None}
    assert set(verdict["pii_columns"]) == expected


def test_detects_pii_through_messy_casing_and_padding():
    frame = pd.DataFrame(
        {"who": ["  Marcus Okonkwo ", "PRIYA NAKAMURA", "devon underhill", "Rosa Delacroix"]}
    )
    assert classify.classify_series(frame["who"]) == ("name", 1.0)


def test_blank_cells_do_not_count_against_the_match_rate():
    frame = pd.DataFrame({"ssn": ["900-11-2222", "", "901-33-4444", ""]})
    pii_type, rate = classify.classify_series(frame["ssn"])
    assert pii_type == "ssn"
    assert rate == 1.0


def test_a_mostly_clean_column_survives_a_few_dirty_cells():
    frame = pd.DataFrame({"ssn": ["900-11-2222", "901-33-4444", "902-55-6666", "unknown"]})
    pii_type, rate = classify.classify_series(frame["ssn"])
    assert pii_type == "ssn"
    assert rate == pytest.approx(0.75)


def test_a_column_below_threshold_is_not_labelled():
    frame = pd.DataFrame({"notes": ["900-11-2222", "n/a", "see chart", "pending"]})
    pii_type, rate = classify.classify_series(frame["notes"])
    assert pii_type is None
    assert rate == pytest.approx(0.25)


def test_an_empty_column_is_not_labelled():
    frame = pd.DataFrame({"unused": ["", "", ""]})
    assert classify.classify_series(frame["unused"]) == (None, 0.0)


def test_populated_and_blank_counts_describe_the_file():
    frame = pd.DataFrame({"phone": ["555-555-0100", "", "  ", "555-555-0101"]})
    verdict = classify.build_verdict(frame)
    assert column(verdict, "phone")["populated"] == 2
    assert column(verdict, "phone")["blank"] == 2


# --- the boundary ---


def test_example_is_none_on_every_column(verdict):
    assert all(c["example"] is None for c in verdict["columns"])


def test_verdict_contains_no_cell_values(raw_csv):
    """Nothing in the output may echo the input."""
    path, _ = raw_csv
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    rendered = json.dumps(classify.classify_csv(path))

    for col in frame.columns:
        for value in frame[col].dropna().unique():
            text = str(value).strip()
            if len(text) >= classify.MIN_LEAK_CHECK_LENGTH:
                assert text not in rendered


def test_verdict_contains_no_canary(raw_csv):
    path, canary = raw_csv
    rendered = json.dumps(classify.classify_csv(path))
    assert canary.ssn not in rendered
    assert canary.name not in rendered


def test_verdict_keys_are_a_closed_set(verdict):
    """New fields should be deliberate, not drift."""
    for col in verdict["columns"]:
        assert set(col) == {
            "name",
            "dtype",
            "populated",
            "blank",
            "pii_type",
            "match_rate",
            "example",
        }


def test_leak_backstop_fires_when_a_value_reaches_the_output():
    """The regression the backstop exists to catch."""
    frame = pd.DataFrame({"ssn": ["900-11-2222", "901-33-4444"]})
    leaky = json.dumps({"columns": [{"name": "ssn", "example": "900-11-2222"}]})

    with pytest.raises(AssertionError, match="would have leaked"):
        classify.assert_no_values_leaked(leaky, frame)


def test_leak_backstop_ignores_short_values():
    """Otherwise it fires on every run."""
    frame = pd.DataFrame({"adverse_event": ["Yes", "No", "1"]})
    classify.assert_no_values_leaked(json.dumps({"row_count": 1}), frame)


# --- the CLI contract ---


def test_cli_prints_parseable_json_and_no_values(raw_csv, tmp_path: Path):
    path, canary = raw_csv
    out = tmp_path / "verdict.json"

    result = subprocess.run(  # noqa: S603
        [
            sys.executable,
            str(REPO_ROOT / "python" / "classify.py"),
            str(path),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    parsed = json.loads(result.stdout)
    assert parsed["row_count"] == 200
    assert canary.ssn not in result.stdout
    assert canary.name not in result.stdout
    assert json.loads(out.read_text()) == parsed
