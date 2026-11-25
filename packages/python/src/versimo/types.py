from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional, Union

# A record is a plain dict with the keys of the JSON format:
# module, last, current, next, rollout, healthy, updatedAt and optional history.
ModuleRecord = dict[str, Any]


@dataclass(frozen=True)
class Resolution:
    version: str
    channel: str  # "next", "current" or "last"
    reason: str  # "ROLLOUT", "DEFAULT", "NO_USER" or "UNHEALTHY"
    bucket: Optional[int]  # None when there was no user id


# A datetime, an ISO 8601 string, or milliseconds since the epoch.
Moment = Union[datetime, str, int, float]
