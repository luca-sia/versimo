from __future__ import annotations

from typing import Optional

from .bucket import bucket_for
from .types import ModuleRecord, Resolution


def resolve(record: ModuleRecord, user_id: Optional[str] = None) -> Resolution:
    """Like resolve_version, but says which channel was chosen and why."""
    if not record["healthy"]:
        if record["last"] is not None:
            return Resolution(record["last"], "last", "UNHEALTHY", None)
        return Resolution(record["current"], "current", "UNHEALTHY", None)
    if not user_id:
        return Resolution(record["current"], "current", "NO_USER", None)
    bucket = bucket_for(record["module"], user_id)
    if record["next"] is not None and bucket < record["rollout"]:
        return Resolution(record["next"], "next", "ROLLOUT", bucket)
    return Resolution(record["current"], "current", "DEFAULT", bucket)


def resolve_version(record: ModuleRecord, user_id: Optional[str] = None) -> str:
    """The version of the module this user should get."""
    return resolve(record, user_id).version
