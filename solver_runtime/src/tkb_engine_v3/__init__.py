"""TKB Engine v3 — one-button timetable engine (pure Python, FET-family local search).

Contract (lexicographic, hard-first):
  1. 100% periods placed, all hard/app constraints valid (never violated)
  2. one-period teacher sessions == 0 (or proven structural floor)
  3. teacher sessions with gap >= 2 == 0 (or proven structural floor)
  4. minimize total teacher sessions
  5. minimize teacher sessions with gap == 1
  6. tie-break: fewer teaching days

All user "limits" (gioi han) are UPPER BOUNDS (<=), never mandatory targets.
No OR-Tools dependency; runs identically on local start.py, VPS and Cloud Run.
"""

from .entry import solve_from_ui_data_v3  # noqa: F401

ENGINE_VERSION = "tkb-engine-v3.0"
