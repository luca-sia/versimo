"""Versimo: resolve last, current and next versions of a module for each user."""

from .bucket import bucket_for
from .client import Client, create_client
from .errors import VersimoError
from .posthog import POSTHOG_DISTINCT_ID, PostHogRollout, posthog_flag_key, rollout_from_flag
from .health import HEALTH_ACTOR, HealthResult, HealthVerdict, check_health, evaluate_health
from .resolve import resolve, resolve_version
from .semver import SEMVER_PATTERN, compare_semver, is_semver, parse_semver
from .transitions import draft_next, promote, rollback, set_rollout
from .types import ModuleRecord, Resolution
from .validate import ValidationResult, validate_record

__version__ = "0.2.0"

__all__ = [
    "Client",
    "POSTHOG_DISTINCT_ID",
    "PostHogRollout",
    "HEALTH_ACTOR",
    "HealthResult",
    "HealthVerdict",
    "ModuleRecord",
    "Resolution",
    "SEMVER_PATTERN",
    "ValidationResult",
    "VersimoError",
    "bucket_for",
    "check_health",
    "compare_semver",
    "create_client",
    "draft_next",
    "evaluate_health",
    "is_semver",
    "parse_semver",
    "promote",
    "resolve",
    "posthog_flag_key",
    "resolve_version",
    "rollback",
    "rollout_from_flag",
    "set_rollout",
    "validate_record",
]
