from __future__ import annotations

from typing import Any


CP_SAT_RANDOM_SEED_MAX = 2_147_483_646


def normalize_cp_sat_seed(value: Any) -> int | None:
    """Map arbitrary client seeds into OR-Tools' positive signed-int32 range."""
    if value is None or value == "":
        return None
    try:
        raw = int(float(str(value).strip()))
    except (TypeError, ValueError, OverflowError):
        return None
    return ((raw - 1) % CP_SAT_RANDOM_SEED_MAX) + 1
