package dev.versimo

enum class ErrorCode { INVALID_INPUT, INVALID_RECORD, NOT_FOUND, SOURCE_ERROR }

class VersimoException(val code: ErrorCode, message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)
