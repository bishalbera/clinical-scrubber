"""Tests for the post-scrub verifier.

The Compliance subagent writes its own scrub script, so nothing here can assume the
scrub was correct. These cases cover the ways it can be wrong: a dropped column that
was not really dropped, a hash that is not a hash, and a canary that survived.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

import gen_data
import verify_scrub


def write(tmp_path: Path, frame: pd.DataFrame, name: str = "scrubbed.csv") -> Path:
    path = tmp_path / name
    frame.to_csv(path, index=False)
    return path


def test_clean_scrub_passes(tmp_path: Path):
    frame = pd.DataFrame(
        {
            "subject_pseudo_id": ["a1b2c3", "d4e5f6"],
            "age_band": ["45-54", "55-64"],
            "arm": ["treatment", "placebo"],
            "outcome_measure": ["-5.2", "-1.1"],
        }
    )
    result = verify_scrub.verify(write(tmp_path, frame), None)
    assert result["passed"] is True
    assert result["surviving_identifier_columns"] == []


@pytest.mark.parametrize(
    ("column", "values"),
    [
        ("ssn", ["900-11-2222", "901-33-4444"]),
        ("patient_name", ["Marcus Okonkwo", "Priya Nakamura"]),
        ("email", ["a.b@example.com", "c.d@example.com"]),
        ("phone", ["555-555-0100", "555-555-0101"]),
        ("dob", ["1981-12-07", "1975-03-02"]),
        ("mrn", ["MRN123456", "MRN654321"]),
    ],
)
def test_surviving_identifier_fails_the_check(tmp_path: Path, column, values):
    frame = pd.DataFrame({column: values, "arm": ["treatment", "placebo"]})
    result = verify_scrub.verify(write(tmp_path, frame), None)

    assert result["passed"] is False
    assert [c["name"] for c in result["surviving_identifier_columns"]] == [column]


def test_renaming_a_column_does_not_hide_its_contents(tmp_path: Path):
    """Detection is by value, not by column name — renaming ssn to notes proves nothing."""
    frame = pd.DataFrame({"notes": ["900-11-2222", "901-33-4444"], "arm": ["t", "p"]})
    result = verify_scrub.verify(write(tmp_path, frame), None)

    assert result["passed"] is False
    assert result["surviving_identifier_columns"][0]["pii_type"] == "ssn"


def test_canary_survival_is_reported(tmp_path: Path):
    canary = {"ssn": "984-42-0266", "name": "Barnabas Ashdown-Vance"}
    canary_path = tmp_path / ".canary.json"
    canary_path.write_text(json.dumps(canary))

    frame = pd.DataFrame({"free_text": ["nothing", "984-42-0266"], "arm": ["t", "p"]})
    result = verify_scrub.verify(write(tmp_path, frame), canary_path)

    assert result["canary_present"] is True
    assert result["passed"] is False


def test_canary_absence_is_reported(tmp_path: Path):
    canary = {"ssn": "984-42-0266", "name": "Barnabas Ashdown-Vance"}
    canary_path = tmp_path / ".canary.json"
    canary_path.write_text(json.dumps(canary))

    frame = pd.DataFrame({"age_band": ["45-54", "55-64"], "arm": ["t", "p"]})
    result = verify_scrub.verify(write(tmp_path, frame), canary_path)

    assert result["canary_present"] is False
    assert result["passed"] is True


def test_canary_hidden_in_a_free_text_column_is_caught(tmp_path: Path):
    """A name can survive a scrubber that only strips digit patterns."""
    canary = {"ssn": "984-42-0266", "name": "Barnabas Ashdown-Vance"}
    canary_path = tmp_path / ".canary.json"
    canary_path.write_text(json.dumps(canary))

    frame = pd.DataFrame(
        {"comment": ["routine visit", "spoke with Barnabas Ashdown-Vance"], "arm": ["t", "p"]}
    )
    result = verify_scrub.verify(write(tmp_path, frame), canary_path)

    assert result["canary_present"] is True


def test_output_contains_no_cell_values(tmp_path: Path):
    """The verdict crosses back to the model, so it may not echo the data."""
    records, _, canary = gen_data.generate_trial(rows=60, seed=7)
    raw = tmp_path / "raw.csv"
    gen_data.write_csv(raw, records)

    rendered = json.dumps(verify_scrub.verify(raw, None))
    assert canary.ssn not in rendered
    assert canary.name not in rendered

    frame = pd.read_csv(raw, dtype=str, keep_default_na=False)
    for col in frame.columns:
        for value in frame[col].dropna().unique():
            text = str(value).strip()
            if len(text) >= 5:
                assert text not in rendered


def test_reports_row_count_and_columns(tmp_path: Path):
    frame = pd.DataFrame({"age_band": ["45-54"] * 3, "arm": ["t", "p", "t"]})
    result = verify_scrub.verify(write(tmp_path, frame), None)

    assert result["row_count"] == 3
    assert result["columns"] == ["age_band", "arm"]


def test_missing_canary_file_fails_rather_than_skipping(tmp_path: Path):
    """Deleting the canary file must not silently disable the sharpest check."""
    frame = pd.DataFrame({"age_band": ["45-54", "55-64"], "arm": ["t", "p"]})
    result = verify_scrub.verify(write(tmp_path, frame), tmp_path / "absent.json")

    assert result["passed"] is False
    assert "not found" in str(result["error"])


def test_malformed_canary_file_fails(tmp_path: Path):
    bad = tmp_path / ".canary.json"
    bad.write_text("{not json")
    frame = pd.DataFrame({"age_band": ["45-54"], "arm": ["t"]})
    result = verify_scrub.verify(write(tmp_path, frame), bad)

    assert result["passed"] is False
    assert "valid JSON" in str(result["error"])


def test_canary_file_without_values_fails(tmp_path: Path):
    bad = tmp_path / ".canary.json"
    bad.write_text(json.dumps({"row_index": 3}))
    frame = pd.DataFrame({"age_band": ["45-54"], "arm": ["t"]})
    result = verify_scrub.verify(write(tmp_path, frame), bad)

    assert result["passed"] is False
    assert "missing ssn or name" in str(result["error"])


def test_surviving_study_id_fails_the_check(tmp_path: Path):
    """A per-participant study number re-links every row to one person."""
    frame = pd.DataFrame(
        {"subject_id": ["STUDY-0001", "STUDY-0002", "STUDY-0003"], "arm": ["t", "p", "t"]}
    )
    result = verify_scrub.verify(write(tmp_path, frame), None)

    assert result["passed"] is False
    assert result["surviving_identifier_columns"][0]["pii_type"] == "study_id"


def test_shared_site_codes_are_not_direct_identifiers(tmp_path: Path):
    """A code many participants share identifies a site, not a person."""
    frame = pd.DataFrame(
        {"site": ["SITE-001", "SITE-001", "SITE-002", "SITE-002"], "arm": ["t", "p", "t", "p"]}
    )
    result = verify_scrub.verify(write(tmp_path, frame), None)

    assert result["passed"] is True


def test_run_id_is_echoed(tmp_path: Path):
    frame = pd.DataFrame({"age_band": ["45-54"], "arm": ["t"]})
    result = verify_scrub.verify(write(tmp_path, frame), None, "run-abc")

    assert result["run_id"] == "run-abc"
