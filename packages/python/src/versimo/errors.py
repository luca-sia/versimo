from __future__ import annotations

# Codes: INVALID_INPUT, INVALID_RECORD, NOT_FOUND, SOURCE_ERROR


class VersimoError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
