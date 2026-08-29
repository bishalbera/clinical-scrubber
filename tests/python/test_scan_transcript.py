"""Tests for the in-sandbox transcript comparison.

This covers the hole the shape-based guard leaves: a patient name matches no regex, so
only a comparison against the real values can catch it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

import gen_data
import scan_transcript

FRAME = pd.DataFrame(
    {
        "patient_name": ["Marcus Okonkwo", "Priya Nakamura"],
        "subject_id": ["STUDY-0001", "STUDY-0002"],
        "ssn": ["900-11-2222", "901-33-4444"],
        "arm": ["treatment", "placebo"],
    }
)


def test_catches_a_name_no_regex_would_match():
    result = scan_transcript.scan(
        "the participant Marcus Okonkwo withdrew", FRAME, ["patient_name"]
    )

    assert result["leaked"] is True
    assert result["matches"][0]["column"] == "patient_name"


def test_catches_a_subject_id():
    result = scan_transcript.scan("row for STUDY-0002 looks odd", FRAME, ["subject_id"])
    assert result["leaked"] is True


def test_clean_text_passes():
    result = scan_transcript.scan(
        "n=240, mean change -5.6, p=0.0004, columns: patient_name, ssn",
        FRAME,
        ["patient_name", "subject_id", "ssn"],
    )
    assert result["leaked"] is False


def test_column_names_are_not_values():
    """The model is supposed to see the schema; that must not read as a leak."""
    result = scan_transcript.scan("Columns: patient_name, subject_id, ssn, arm", FRAME, list(FRAME))
    assert result["leaked"] is False


def test_short_values_are_skipped():
    """A two-character arm code appears in ordinary prose constantly."""
    frame = pd.DataFrame({"arm": ["t", "p"], "flag": ["Y", "N"]})
    result = scan_transcript.scan("treatment vs placebo, p=0.03", frame, ["arm", "flag"])
    assert result["leaked"] is False


def test_reports_per_column_without_echoing_values():
    result = scan_transcript.scan("Marcus Okonkwo and 900-11-2222", FRAME, list(FRAME))
    rendered = json.dumps(result)

    assert result["leaked"] is True
    assert "Marcus Okonkwo" not in rendered
    assert "900-11-2222" not in rendered


def test_missing_columns_are_ignored():
    result = scan_transcript.scan("nothing here", FRAME, ["not_a_column"])
    assert result["leaked"] is False
    assert result["columns_checked"] == []


#: What the classifier flags on the generated dataset.
IDENTIFIER_COLUMNS = [
    "subject_id", "patient_name", "ssn", "mrn", "dob", "email", "phone", "address",
]


def test_against_the_real_generator(tmp_path: Path):
    records, index, canary = gen_data.generate_trial(rows=60, seed=11)
    path = tmp_path / "raw.csv"
    gen_data.write_csv(path, records)
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)

    leaked_row = ", ".join(records[index].values())
    result = scan_transcript.scan(leaked_row, frame, IDENTIFIER_COLUMNS)
    assert result["leaked"] is True
    assert canary.ssn not in json.dumps(result)

    clean = "n=60, treatment vs placebo, p=0.03, columns: ssn, dob, mrn"
    assert scan_transcript.scan(clean, frame, IDENTIFIER_COLUMNS)["leaked"] is False


def test_analysis_categories_are_not_identifiers(tmp_path: Path):
    """arm=treatment is what the pipeline exists to discuss, not a leak."""
    records, _, _ = gen_data.generate_trial(rows=40, seed=3)
    path = tmp_path / "raw.csv"
    gen_data.write_csv(path, records)
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)

    text = "Treatment arm improved more than placebo (p=0.0004)."
    assert scan_transcript.scan(text, frame, IDENTIFIER_COLUMNS)["leaked"] is False
