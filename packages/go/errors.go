package versimo

// ErrorCode says what went wrong.
type ErrorCode string

const (
	CodeInvalidInput  ErrorCode = "INVALID_INPUT"
	CodeInvalidRecord ErrorCode = "INVALID_RECORD"
	CodeNotFound      ErrorCode = "NOT_FOUND"
	CodeSourceError   ErrorCode = "SOURCE_ERROR"
)

// Error is the error type of this package. Use errors.As to read the code.
type Error struct {
	Code    ErrorCode
	Message string
	Err     error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Err }

func newError(code ErrorCode, message string) *Error {
	return &Error{Code: code, Message: message}
}
