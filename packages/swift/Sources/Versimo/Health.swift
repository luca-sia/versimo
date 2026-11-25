import Foundation

/// Recorded as `by` in history when the caller gives no name.
public let healthActor = "versimo-health"

/// Limits for one module. A nil field turns that check off.
/// `maxErrorRate` is from 0 to 1. `maxLatencyMs` is usually p95. `url` must answer with a 2xx status.
/// The error rate is only judged once there are at least `minRequests` requests, default 1.
public struct HealthChecks: Equatable, Sendable {
    public var maxErrorRate: Double?
    public var maxLatencyMs: Double?
    public var url: String?
    public var minRequests: Int?

    public init(maxErrorRate: Double? = nil, maxLatencyMs: Double? = nil, url: String? = nil, minRequests: Int? = nil) {
        self.maxErrorRate = maxErrorRate
        self.maxLatencyMs = maxLatencyMs
        self.url = url
        self.minRequests = minRequests
    }
}

/// What was measured for current. A nil field skips that check. `urlStatus` 0 means unreachable.
public struct HealthObservation: Equatable, Sendable {
    public var requests: Int?
    public var errors: Int?
    public var latencyMs: Double?
    public var urlStatus: Int?

    public init(requests: Int? = nil, errors: Int? = nil, latencyMs: Double? = nil, urlStatus: Int? = nil) {
        self.requests = requests
        self.errors = errors
        self.latencyMs = latencyMs
        self.urlStatus = urlStatus
    }
}

/// One failed check: `errorRate`, `latency` or `url`. `limit` is nil for the URL check.
public struct HealthFailure: Equatable, Sendable {
    public let check: String
    public let value: Double
    public let limit: Double?

    public init(check: String, value: Double, limit: Double?) {
        self.check = check
        self.value = value
        self.limit = limit
    }
}

/// Failed checks, always in the order errorRate, latency, url.
public struct HealthVerdict: Equatable, Sendable {
    public let healthy: Bool
    public let failures: [HealthFailure]
}

/// The record after the check, the verdict, and whether it rolled back.
public struct HealthResult: Equatable, Sendable {
    public let record: ModuleRecord
    public let verdict: HealthVerdict
    public let rolledBack: Bool
}

private func checkInputs(_ c: HealthChecks, _ o: HealthObservation) throws {
    func bad(_ message: String) -> VersimoError { VersimoError(.invalidInput, message) }
    if let v = c.maxErrorRate, !v.isFinite || v < 0 || v > 1 { throw bad("maxErrorRate must be a number from 0 to 1") }
    if let v = c.maxLatencyMs, !v.isFinite || v < 0 { throw bad("maxLatencyMs must be a number of 0 or more") }
    if let v = c.url, v.isEmpty { throw bad("url must be a non-empty string") }
    if let v = c.minRequests, v < 0 { throw bad("minRequests must be an integer of 0 or more") }
    if let v = o.requests, v < 0 { throw bad("requests must be an integer of 0 or more") }
    if let v = o.errors, v < 0 { throw bad("errors must be an integer of 0 or more") }
    if let e = o.errors, let r = o.requests, e > r { throw bad("errors cannot be more than requests") }
    if let v = o.latencyMs, !v.isFinite || v < 0 { throw bad("latencyMs must be a number of 0 or more") }
    if let v = o.urlStatus, v < 0 { throw bad("urlStatus must be an integer of 0 or more") }
}

/// Judges one observation against the checks. It is the same in every language.
public func evaluateHealth(_ checks: HealthChecks, _ observation: HealthObservation) throws -> HealthVerdict {
    try checkInputs(checks, observation)
    var failures: [HealthFailure] = []
    if let limit = checks.maxErrorRate, let requests = observation.requests, let errors = observation.errors,
       requests >= max(1, checks.minRequests ?? 1) {
        let rate = Double(errors) / Double(requests)
        if rate > limit { failures.append(HealthFailure(check: "errorRate", value: rate, limit: limit)) }
    }
    if let limit = checks.maxLatencyMs, let latency = observation.latencyMs, latency > limit {
        failures.append(HealthFailure(check: "latency", value: latency, limit: limit))
    }
    if checks.url != nil, let status = observation.urlStatus, status < 200 || status > 299 {
        failures.append(HealthFailure(check: "url", value: Double(status), limit: nil))
    }
    return HealthVerdict(healthy: failures.isEmpty, failures: failures)
}

/// Judges current and, when it fails, steps back to last on its own.
/// The rollback is recorded in history with the failed checks as the reason,
/// for example `health: errorRate, latency`. With no last the record is left
/// as it is and only the verdict says it failed.
public func checkHealth(
    _ record: ModuleRecord, checks: HealthChecks, observation: HealthObservation,
    options: TransitionOptions = TransitionOptions()
) throws -> HealthResult {
    let verdict = try evaluateHealth(checks, observation)
    if verdict.healthy || record.last == nil {
        return HealthResult(record: record, verdict: verdict, rolledBack: false)
    }
    var opts = options
    opts.by = options.by ?? healthActor
    opts.reason = "health: " + verdict.failures.map(\.check).joined(separator: ", ")
    return HealthResult(record: try rollback(record, options: opts), verdict: verdict, rolledBack: true)
}
