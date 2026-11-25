from __future__ import annotations

import re
from typing import Any

_IDENT = r"(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"
SEMVER_PATTERN = (
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    rf"(?:-({_IDENT}(?:\.{_IDENT})*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)
# fullmatch, because `$` would also accept a trailing newline.
_SEMVER = re.compile(SEMVER_PATTERN)


def is_semver(value: Any) -> bool:
    return isinstance(value, str) and _SEMVER.fullmatch(value) is not None


def parse_semver(value: str) -> tuple[int, int, int, list[str]]:
    """Return (major, minor, patch, prerelease identifiers)."""
    m = _SEMVER.fullmatch(value) if isinstance(value, str) else None
    if m is None:
        raise ValueError(f"Invalid semver: {value!r}")
    pre = m.group(4).split(".") if m.group(4) else []
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), pre


def _cmp_numeric(a: str, b: str) -> int:
    # No leading zeros, so length then text compares exactly, with no overflow.
    if len(a) != len(b):
        return -1 if len(a) < len(b) else 1
    return (a > b) - (a < b)


def compare_semver(a: str, b: str) -> int:
    """Return -1, 0 or 1. Build metadata is ignored."""
    ma = _SEMVER.fullmatch(a) if isinstance(a, str) else None
    mb = _SEMVER.fullmatch(b) if isinstance(b, str) else None
    if ma is None or mb is None:
        raise ValueError(f"Invalid semver: {(a if ma is None else b)!r}")
    for i in (1, 2, 3):
        c = _cmp_numeric(ma.group(i), mb.group(i))
        if c:
            return c
    x = ma.group(4).split(".") if ma.group(4) else []
    y = mb.group(4).split(".") if mb.group(4) else []
    if not x and not y:
        return 0
    if not x:
        return 1
    if not y:
        return -1
    for i in range(max(len(x), len(y))):
        if i >= len(x):
            return -1
        if i >= len(y):
            return 1
        p, q = x[i], y[i]
        if p == q:
            continue
        pn, qn = p.isascii() and p.isdigit(), q.isascii() and q.isdigit()
        if pn and qn:
            return _cmp_numeric(p, q)
        if pn:
            return -1
        if qn:
            return 1
        return -1 if p < q else 1
    return 0
