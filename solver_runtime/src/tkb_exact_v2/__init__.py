"""Exact, fail-closed timetable solver V2.

The package intentionally owns a new CP-SAT model.  It may reuse the
canonical UI-data decoder and the authoritative validator, but it does not
call the legacy FET/local-search/portfolio pipeline.
"""

from .solver import ExactV2NoSolution, solve_exact_v2_from_ui_data

__all__ = ["ExactV2NoSolution", "solve_exact_v2_from_ui_data"]
