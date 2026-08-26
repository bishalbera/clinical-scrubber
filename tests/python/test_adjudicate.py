"""Tests for the leak adjudicator.

Its whole purpose is to separate a leaked patient value from an identifier-shaped
example an agent typed into its own code. Getting either direction wrong defeats the
guard, so both are covered.
"""

from __future__ import annotations

import json
from pathlib import Path

import adjudicate


def data_file(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "trial_raw.csv"
    path.write_text(text, encoding="utf-8")
    return path


def test_value_present_in_the_data_is_a_leak(tmp_path: Path):
    data = data_file(tmp_path, "ssn,name\n900-73-1893,Bob\n")
    result = adjudicate.adjudicate(["900-73-1893"], [data])

    assert result["leaked"] is True
    assert result["findings"][0]["occurrences"] == 1


def test_value_absent_from_the_data_is_not_a_leak(tmp_path: Path):
    """The agent writing `# e.g. 123-45-6789` in its own code is not a breach."""
    data = data_file(tmp_path, "ssn,name\n900-73-1893,Bob\n")
    result = adjudicate.adjudicate(["123-45-6789"], [data])

    assert result["leaked"] is False
    assert result["findings"][0]["occurrences"] == 0


def test_mixed_candidates_report_per_candidate(tmp_path: Path):
    data = data_file(tmp_path, "ssn\n900-73-1893\n")
    result = adjudicate.adjudicate(["900-73-1893", "123-45-6789"], [data])

    assert [f["occurrences"] for f in result["findings"]] == [1, 0]
    assert result["leaked"] is True


def test_output_never_echoes_a_candidate(tmp_path: Path):
    """The result crosses back to the model, so it identifies by hash, not by value."""
    data = data_file(tmp_path, "ssn\n900-73-1893\n")
    rendered = json.dumps(adjudicate.adjudicate(["900-73-1893"], [data]))

    assert "900-73-1893" not in rendered


def test_missing_files_are_skipped_not_fatal(tmp_path: Path):
    data = data_file(tmp_path, "ssn\n900-73-1893\n")
    result = adjudicate.adjudicate(["900-73-1893"], [tmp_path / "absent.csv", data])

    assert result["leaked"] is True
    assert str(data) in result["files_searched"]


def test_no_candidates_is_not_a_leak(tmp_path: Path):
    data = data_file(tmp_path, "ssn\n900-73-1893\n")
    result = adjudicate.adjudicate([], [data])

    assert result["leaked"] is False
    assert result["findings"] == []


def test_counts_repeated_occurrences(tmp_path: Path):
    data = data_file(tmp_path, "a\n900-73-1893\n900-73-1893\n")
    result = adjudicate.adjudicate(["900-73-1893"], [data])

    assert result["findings"][0]["occurrences"] == 2
