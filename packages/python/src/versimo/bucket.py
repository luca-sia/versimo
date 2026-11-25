from __future__ import annotations


def bucket_for(module: str, user_id: str) -> int:
    """Map a module and user to a stable bucket from 0 to 99.

    FNV-1a over the UTF-8 bytes of module, a NUL byte and user_id,
    then the murmur3 32-bit finaliser, then modulo 100.
    """
    h = 0x811C9DC5
    for byte in f"{module}\x00{user_id}".encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    h ^= h >> 16
    return h % 100
