"""Versimo: resolve last, current and next versions of a module for each user."""

from .bucket import bucket_for
from .client import Client, create_client
from .errors import VersimoError
from .resolve import resolve, resolve_version
from .semver import SEMVER_PATTERN, compare_semver, is_semver, parse_semver
from .transitions import draft_next, promote, rollback, set_rollout
from .types import ModuleRecord, Resolution
from .validate import ValidationResult, validate_record

__version__ = "0.2.0"

__all__ = [
    "Client",
    "ModuleRecord",
    "Resolution",
    "SEMVER_PATTERN",
    "ValidationResult",
    "VersimoError",
    "bucket_for",
    "compare_semver",
    "create_client",
    "draft_next",
    "is_semver",
    "parse_semver",
    "promote",
    "resolve",
    "resolve_version",
    "rollback",
    "set_rollout",
    "validate_record",
]
