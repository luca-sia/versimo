"""Rollout share from PostHog feature flags.

PostHog only sets how many users are on `next`. Who they are is still decided
by `bucket_for`, so every language gives the same answer.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from .errors import VersimoError

# A rollout source returns the share on `next` for a module, or None to keep the record's rollout.
RolloutSource = Callable[[str], Optional[int]]
# Posts a JSON body to a URL and returns (status, body).
Poster = Callable[[str, bytes], tuple[int, bytes]]

# The fixed distinct id sent to PostHog. No user id ever leaves the app.
POSTHOG_DISTINCT_ID = "versimo"


def posthog_flag_key(module: str) -> str:
    """The PostHog flag that carries the share for a module."""
    return f"versimo-{module}"


def rollout_from_flag(flag: Any) -> Optional[int]:
    """The share on `next` from one flag in a PostHog `/flags?v=2` answer.

    No flag gives None. Flag off gives 0. Flag on with a payload
    `{"rollout": n}`, n an integer from 0 to 100, gives n. Anything else gives None.
    """
    if not isinstance(flag, dict):
        return None
    enabled = flag.get("enabled")
    if enabled is False:
        return 0
    if enabled is not True:
        return None
    metadata = flag.get("metadata")
    payload = metadata.get("payload") if isinstance(metadata, dict) else None
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    if not isinstance(payload, dict):
        return None
    n = payload.get("rollout")
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    if isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= 100:
        return None
    return n


def _urlopen_post(timeout: float) -> Poster:
    def post(url: str, body: bytes) -> tuple[int, bytes]:
        req = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            return err.code, b""

    return post


class PostHogRollout:
    """A rollout source backed by PostHog flags, for `Client(source, rollout=...)`.

    One request per TTL serves every module. It carries only the project key and
    the fixed distinct id, so no user data is sent. When PostHog cannot be reached
    the last good answer is kept, and with none the record's own rollout is used.
    """

    def __init__(
        self,
        api_key: str,
        *,
        host: str = "https://eu.i.posthog.com",
        ttl_ms: int = 30_000,
        now: Optional[Callable[[], float]] = None,
        post: Optional[Poster] = None,
        timeout: float = 5.0,
    ) -> None:
        if not api_key:
            raise VersimoError("INVALID_INPUT", "PostHogRollout needs an api_key")
        self._api_key = api_key
        self._url = f"{host.rstrip('/')}/flags?v=2"
        self._ttl_ms = ttl_ms
        self._now = now or (lambda: time.time() * 1000)
        self._post = post or _urlopen_post(timeout)
        self._flags: Optional[dict[str, Any]] = None
        self._expires = 0.0
        self._lock = threading.Lock()

    def _load(self) -> dict[str, Any]:
        body = json.dumps({"api_key": self._api_key, "distinct_id": POSTHOG_DISTINCT_ID}).encode()
        status, raw = self._post(self._url, body)
        if not 200 <= status < 300:
            raise VersimoError("SOURCE_ERROR", f"PostHog returned {status}")
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get("flags"), dict):
            raise VersimoError("SOURCE_ERROR", "PostHog answer has no flags")
        return data["flags"]

    def flags(self) -> Optional[dict[str, Any]]:
        with self._lock:
            if self._flags is not None and self._expires > self._now():
                return self._flags
            try:
                self._flags = self._load()
            except Exception:
                # Keep the last good answer for another TTL. With none, use the record.
                if self._flags is None:
                    return None
            self._expires = self._now() + self._ttl_ms
            return self._flags

    def __call__(self, module: str) -> Optional[int]:
        flags = self.flags()
        return rollout_from_flag(flags.get(posthog_flag_key(module))) if flags is not None else None
