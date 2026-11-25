from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from .errors import VersimoError
from .transitions import rollback
from .types import ModuleRecord, Moment

# Recorded as `by` in history when the caller gives no name.
HEALTH_ACTOR = "versimo-health"

# Checks and observations are plain dicts with the keys of the JSON format.
# Checks: maxErrorRate (0 to 1), maxLatencyMs, url, minRequests (default 1).
# Observation: requests, errors, latencyMs, urlStatus (0 means unreachable).
# A missing key turns that check off or skips it.


@dataclass(frozen=True)
class HealthVerdict:
    healthy: bool
    # Each failure is {"check", "value", "limit"}, in the order errorRate, latency, url.
    failures: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class HealthResult:
    record: ModuleRecord
    verdict: HealthVerdict
    rolled_back: bool


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_count(v: Any) -> bool:
    return _is_number(v) and float(v).is_integer() and v >= 0


def _invalid(message: str) -> None:
    raise VersimoError("INVALID_INPUT", message)


def _check_inputs(checks: Mapping[str, Any], obs: Mapping[str, Any]) -> None:
    if "maxErrorRate" in checks:
        v = checks["maxErrorRate"]
        if not _is_number(v) or v < 0 or v > 1:
            _invalid("maxErrorRate must be a number from 0 to 1")
    if "maxLatencyMs" in checks:
        v = checks["maxLatencyMs"]
        if not _is_number(v) or v < 0:
            _invalid("maxLatencyMs must be a number of 0 or more")
    if "url" in checks and (not isinstance(checks["url"], str) or checks["url"] == ""):
        _invalid("url must be a non-empty string")
    if "minRequests" in checks and not _is_count(checks["minRequests"]):
        _invalid("minRequests must be an integer of 0 or more")
    if "requests" in obs and not _is_count(obs["requests"]):
        _invalid("requests must be an integer of 0 or more")
    if "errors" in obs and not _is_count(obs["errors"]):
        _invalid("errors must be an integer of 0 or more")
    if "errors" in obs and "requests" in obs and obs["errors"] > obs["requests"]:
        _invalid("errors cannot be more than requests")
    if "latencyMs" in obs and (not _is_number(obs["latencyMs"]) or obs["latencyMs"] < 0):
        _invalid("latencyMs must be a number of 0 or more")
    if "urlStatus" in obs and not _is_count(obs["urlStatus"]):
        _invalid("urlStatus must be an integer of 0 or more")


def evaluate_health(checks: Mapping[str, Any], observation: Mapping[str, Any]) -> HealthVerdict:
    """Judge one observation against the checks. The same in every language."""
    _check_inputs(checks, observation)
    failures: list[dict[str, Any]] = []
    requests = observation.get("requests")
    errors = observation.get("errors")
    latency = observation.get("latencyMs")
    status = observation.get("urlStatus")

    if "maxErrorRate" in checks and requests is not None and errors is not None:
        if requests >= max(1, checks.get("minRequests", 1)):
            rate = float(errors) / float(requests)
            if rate > checks["maxErrorRate"]:
                failures.append({"check": "errorRate", "value": rate, "limit": checks["maxErrorRate"]})
    if "maxLatencyMs" in checks and latency is not None and latency > checks["maxLatencyMs"]:
        failures.append({"check": "latency", "value": latency, "limit": checks["maxLatencyMs"]})
    if "url" in checks and status is not None and not (200 <= status <= 299):
        failures.append({"check": "url", "value": status, "limit": None})
    return HealthVerdict(not failures, failures)


def check_health(
    record: ModuleRecord,
    checks: Mapping[str, Any],
    observation: Mapping[str, Any],
    *,
    by: Optional[str] = None,
    now: Optional[Moment] = None,
) -> HealthResult:
    """Judge current and, when it fails, step back to last on its own.

    The rollback is recorded in history with the failed checks as the reason,
    for example "health: errorRate, latency". With no last the record is left
    as it is and only the verdict says it failed.
    """
    verdict = evaluate_health(checks, observation)
    if verdict.healthy or record["last"] is None:
        return HealthResult(record, verdict, False)
    reason = "health: " + ", ".join(f["check"] for f in verdict.failures)
    out = rollback(record, by=by if by is not None else HEALTH_ACTOR, now=now, reason=reason)
    return HealthResult(out, verdict, True)
