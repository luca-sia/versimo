from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional, Union

from .errors import VersimoError
from .posthog import RolloutSource
from .resolve import resolve as _resolve
from .types import ModuleRecord, Resolution
from .validate import validate_record

# A source returns the record for a module, or None when there is none.
Source = Callable[[str], Optional[ModuleRecord]]
# A fetcher takes a URL and returns (status, body).
Fetcher = Callable[[str], tuple[int, bytes]]

_SLUG_OK = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _urlopen_fetch(timeout: float) -> Fetcher:
    def fetch(url: str) -> tuple[int, bytes]:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            return err.code, b""

    return fetch


def _url_source(url: str, fetch: Fetcher) -> Source:
    def source(module: str) -> Optional[ModuleRecord]:
        if "{module}" in url:
            target = url.replace("{module}", module, 1)
        else:
            target = f"{url.rstrip('/')}/{module}.json"
        try:
            status, body = fetch(target)
        except Exception as err:
            raise VersimoError("SOURCE_ERROR", f"Could not fetch {target}: {err}") from err
        if status == 404:
            return None
        if not 200 <= status < 300:
            raise VersimoError("SOURCE_ERROR", f"Fetching {target} returned {status}")
        try:
            return json.loads(body)
        except ValueError as err:
            raise VersimoError("SOURCE_ERROR", f"Fetching {target} returned invalid JSON: {err}") from err

    return source


class Client:
    """Resolves versions from a source, with a TTL cache and stale-on-error.

    `source` is a function from module slug to record (or None), or a URL.
    A URL containing `{module}` has it replaced. Any other URL is a base and
    the client fetches `<base>/<module>.json`.

    `rollout` optionally overrides the record's share on next, for example
    `PostHogRollout(api_key)`. When it gives None or fails, the record's own rollout is used.
    """

    def __init__(
        self,
        source: Union[Source, str],
        *,
        ttl_ms: int = 30_000,
        now: Optional[Callable[[], float]] = None,
        fetch: Optional[Fetcher] = None,
        timeout: float = 10.0,
        rollout: Optional[RolloutSource] = None,
    ) -> None:
        if isinstance(source, str):
            source = _url_source(source, fetch or _urlopen_fetch(timeout))
        self._source = source
        self._rollout = rollout
        self._ttl_ms = ttl_ms
        self._now = now or (lambda: time.time() * 1000)
        self._cache: dict[str, tuple[ModuleRecord, float]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, module: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(module, threading.Lock())

    def _load(self, module: str) -> ModuleRecord:
        raw = self._source(module)
        if raw is None:
            raise VersimoError("NOT_FOUND", f'No record for module "{module}"')
        checked = validate_record(raw)
        if not checked.ok:
            raise VersimoError("INVALID_RECORD", f'Invalid record for "{module}": {"; ".join(checked.errors)}')
        return raw

    def record(self, module: str) -> ModuleRecord:
        """The cached or freshly loaded, validated record, with any rollout override applied."""
        return self._with_rollout(self._stored(module))

    def _with_rollout(self, rec: ModuleRecord) -> ModuleRecord:
        # Only the share changes. Who lands on next is still decided by bucket_for.
        if self._rollout is None:
            return rec
        try:
            share = self._rollout(rec["module"])
        except Exception:
            return rec
        if isinstance(share, bool) or not isinstance(share, int) or not 0 <= share <= 100 or share == rec["rollout"]:
            return rec
        return {**rec, "rollout": share}

    def _stored(self, module: str) -> ModuleRecord:
        if not isinstance(module, str) or _SLUG_OK.fullmatch(module) is None:
            raise VersimoError("INVALID_INPUT", f"Invalid module slug: {json.dumps(module)}")
        # One lock per module, so concurrent callers share a single load.
        with self._lock_for(module):
            hit = self._cache.get(module)
            if hit and hit[1] > self._now():
                return hit[0]
            try:
                rec = self._load(module)
            except Exception as err:
                e = err if isinstance(err, VersimoError) else VersimoError("SOURCE_ERROR", str(err))
                # Serve the stale record when the source is down. A missing or invalid record is not hidden.
                if hit and e.code == "SOURCE_ERROR":
                    self._cache[module] = (hit[0], self._now() + self._ttl_ms)
                    return hit[0]
                if e is err:
                    raise
                raise e from err
            self._cache[module] = (rec, self._now() + self._ttl_ms)
            return rec

    def resolve(self, module: str, user_id: Optional[str] = None) -> Resolution:
        return _resolve(self.record(module), user_id)

    def version(self, module: str, user_id: Optional[str] = None) -> str:
        return self.resolve(module, user_id).version

    def clear(self, module: Optional[str] = None) -> None:
        """Drop one cached record, or all of them."""
        if module is None:
            self._cache.clear()
        else:
            self._cache.pop(module, None)


def create_client(source: Union[Source, str], **options: Any) -> Client:
    return Client(source, **options)
