from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .errors import VersimoError
from .semver import compare_semver, is_semver
from .types import ModuleRecord, Moment


def _stamp(now: Optional[Moment]) -> str:
    try:
        if now is None:
            d = datetime.now(timezone.utc)
        elif isinstance(now, datetime):
            d = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
        elif isinstance(now, str):
            # Python 3.10 cannot read a trailing Z.
            d = datetime.fromisoformat(now[:-1] + "+00:00" if now.endswith("Z") else now)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
        else:
            d = datetime.fromtimestamp(now / 1000, timezone.utc)
    except (ValueError, OverflowError, OSError, TypeError):
        raise VersimoError("INVALID_INPUT", "Invalid `now` option") from None
    d = d.astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def _apply(
    record: ModuleRecord,
    changes: dict[str, Any],
    action: str,
    from_: Optional[str],
    to: Optional[str],
    by: Optional[str],
    now: Optional[Moment],
    reason: Optional[str] = None,
) -> ModuleRecord:
    at = _stamp(now)
    entry: dict[str, Any] = {"at": at, "action": action, "from": from_, "to": to}
    if by is not None:
        entry["by"] = by
    if reason is not None:
        entry["reason"] = reason
    return {**record, **changes, "updatedAt": at, "history": [*record.get("history", []), entry]}


def draft_next(
    record: ModuleRecord,
    version: str,
    *,
    by: Optional[str] = None,
    now: Optional[Moment] = None,
    patch: bool = False,
    reason: Optional[str] = None,
) -> ModuleRecord:
    """Set a new next version at 0% rollout. It replaces any next already drafted."""
    if not is_semver(version):
        raise VersimoError("INVALID_INPUT", f"Invalid semver: {version}")
    if compare_semver(version, record["current"]) <= 0:
        raise VersimoError("INVALID_INPUT", f"Next {version} must be greater than current {record['current']}")
    previous = record["next"] if record["next"] is not None else record["current"]
    return _apply(
        record, {"next": version, "rollout": 0}, "patch" if patch else "draft", previous, version, by, now, reason
    )


def promote(
    record: ModuleRecord, *, by: Optional[str] = None, now: Optional[Moment] = None, reason: Optional[str] = None
) -> ModuleRecord:
    """Move next to current and current to last. Rollout resets to 0."""
    if record["next"] is None:
        raise VersimoError("INVALID_INPUT", "Nothing to promote: next is empty")
    changes = {"last": record["current"], "current": record["next"], "next": None, "rollout": 0, "healthy": True}
    return _apply(record, changes, "promote", record["current"], record["next"], by, now, reason)


def rollback(
    record: ModuleRecord, *, by: Optional[str] = None, now: Optional[Moment] = None, reason: Optional[str] = None
) -> ModuleRecord:
    """Put last back as current. The failed version and any drafted next are dropped."""
    if record["last"] is None:
        raise VersimoError("INVALID_INPUT", "Nothing to roll back to: last is empty")
    changes = {"last": None, "current": record["last"], "next": None, "rollout": 0, "healthy": True}
    return _apply(record, changes, "rollback", record["current"], record["last"], by, now, reason)


def set_rollout(
    record: ModuleRecord,
    n: int,
    *,
    by: Optional[str] = None,
    now: Optional[Moment] = None,
    reason: Optional[str] = None,
) -> ModuleRecord:
    """Set the share of users on next, an integer from 0 to 100."""
    whole = isinstance(n, int) or (isinstance(n, float) and n.is_integer())
    if isinstance(n, bool) or not whole or n < 0 or n > 100:
        raise VersimoError("INVALID_INPUT", "Rollout must be an integer from 0 to 100")
    n = int(n)
    if n > 0 and record["next"] is None:
        raise VersimoError("INVALID_INPUT", "Cannot roll out: next is empty")
    return _apply(record, {"rollout": n}, "rollout", str(record["rollout"]), str(n), by, now, reason)
