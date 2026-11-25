from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .semver import compare_semver, is_semver

_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_DATE_TIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))"
)
_ACTIONS = ["draft", "promote", "rollback", "rollout", "patch"]
_KEYS = ["$schema", "module", "last", "current", "next", "rollout", "healthy", "updatedAt", "history"]
_ENTRY_KEYS = ["at", "action", "from", "to", "by", "reason"]
_MISSING = object()


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)


def _is_date_time(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    m = _DATE_TIME.fullmatch(v)
    if m is None:
        return False
    month, day, hour, minute, second = (int(m.group(i)) for i in (2, 3, 4, 5, 6))
    if not (1 <= month <= 12 and 1 <= day <= 31 and minute <= 59 and second <= 59):
        return False
    # The reference implementation accepts 24:00:00 and any day up to 31.
    if hour > 24 or (hour == 24 and (minute, second) != (0, 0)):
        return False
    if m.group(8) is not None and (int(m.group(8)) > 23 or int(m.group(9)) > 59):
        return False
    return True


def _is_int(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    return isinstance(v, int) or (isinstance(v, float) and v.is_integer())


def _check_entry(entry: Any, path: str, errors: list[str]) -> None:
    if not isinstance(entry, dict):
        errors.append(f"{path} must be an object")
        return
    for key in entry:
        if key not in _ENTRY_KEYS:
            errors.append(f"{path}.{key} is not allowed")
    if not _is_date_time(entry.get("at")):
        errors.append(f"{path}.at must be an ISO 8601 date-time")
    action = entry.get("action")
    if not isinstance(action, str) or action not in _ACTIONS:
        errors.append(f"{path}.action must be one of {', '.join(_ACTIONS)}")
    for key in ("from", "to"):
        v = entry.get(key, _MISSING)
        if v is not None and not isinstance(v, str):
            errors.append(f"{path}.{key} must be a string or null")
    if "by" in entry and not isinstance(entry["by"], str):
        errors.append(f"{path}.by must be a string")
    if "reason" in entry and not isinstance(entry["reason"], str):
        errors.append(f"{path}.reason must be a string")


def validate_record(record: Any) -> ValidationResult:
    """Check a record by hand. It never raises. Each error names the field."""
    errors: list[str] = []
    if not isinstance(record, dict):
        return ValidationResult(False, ["record must be an object"])
    get = record.get

    for key in record:
        if key not in _KEYS:
            errors.append(f"{key} is not allowed")
    if "$schema" in record and not isinstance(record["$schema"], str):
        errors.append("$schema must be a string")
    module = get("module")
    if not isinstance(module, str) or _SLUG.fullmatch(module) is None:
        errors.append('module must be a lower-case slug such as "billing" or "sign-in"')
    last = get("last", _MISSING)
    if last is not None and not is_semver(last):
        errors.append("last must be a semver string or null")
    if not is_semver(get("current")):
        errors.append("current must be a semver string")
    nxt = get("next", _MISSING)
    if nxt is not None and not is_semver(nxt):
        errors.append("next must be a semver string or null")
    rollout = get("rollout")
    if not _is_int(rollout) or rollout < 0 or rollout > 100:
        errors.append("rollout must be an integer from 0 to 100")
    if not isinstance(get("healthy"), bool):
        errors.append("healthy must be a boolean")
    if not _is_date_time(get("updatedAt")):
        errors.append("updatedAt must be an ISO 8601 date-time")

    if "history" in record:
        history = record["history"]
        if isinstance(history, list):
            for i, e in enumerate(history):
                _check_entry(e, f"history[{i}]", errors)
        else:
            errors.append("history must be an array")

    if not errors:
        current = record["current"]
        if nxt is not None and compare_semver(nxt, current) <= 0:
            errors.append("next must be greater than current")
        if last is not None and compare_semver(last, current) >= 0:
            errors.append("last must be lower than current")
        if nxt is None and rollout != 0:
            errors.append("rollout must be 0 when next is null")

    return ValidationResult(not errors, errors)
