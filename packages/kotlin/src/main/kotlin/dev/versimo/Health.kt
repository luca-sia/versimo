package dev.versimo

/** Recorded as `by` in history when the caller gives no name. */
const val HEALTH_ACTOR = "versimo-health"

/**
 * Limits for one module. A null field turns that check off.
 * [maxErrorRate] is from 0 to 1. [maxLatencyMs] is usually p95. [url] must answer with a 2xx status.
 * The error rate is only judged once there are at least [minRequests] requests, default 1.
 */
data class HealthChecks(
    val maxErrorRate: Double? = null,
    val maxLatencyMs: Double? = null,
    val url: String? = null,
    val minRequests: Int? = null,
)

/** What was measured for current. A null field skips that check. [urlStatus] 0 means unreachable. */
data class HealthObservation(
    val requests: Int? = null,
    val errors: Int? = null,
    val latencyMs: Double? = null,
    val urlStatus: Int? = null,
)

/** One failed check: `errorRate`, `latency` or `url`. [limit] is null for the URL check. */
data class HealthFailure(val check: String, val value: Double, val limit: Double?)

/** Failed checks, always in the order errorRate, latency, url. */
data class HealthVerdict(val healthy: Boolean, val failures: List<HealthFailure>)

/** The record after the check, the verdict, and whether it rolled back. */
data class HealthResult(val record: ModuleRecord, val verdict: HealthVerdict, val rolledBack: Boolean)

private fun bad(message: String): Nothing = throw VersimoException(ErrorCode.INVALID_INPUT, message)

private fun checkInputs(c: HealthChecks, o: HealthObservation) {
    c.maxErrorRate?.let { if (!it.isFinite() || it < 0 || it > 1) bad("maxErrorRate must be a number from 0 to 1") }
    c.maxLatencyMs?.let { if (!it.isFinite() || it < 0) bad("maxLatencyMs must be a number of 0 or more") }
    if (c.url != null && c.url.isEmpty()) bad("url must be a non-empty string")
    c.minRequests?.let { if (it < 0) bad("minRequests must be an integer of 0 or more") }
    o.requests?.let { if (it < 0) bad("requests must be an integer of 0 or more") }
    o.errors?.let { if (it < 0) bad("errors must be an integer of 0 or more") }
    if (o.errors != null && o.requests != null && o.errors > o.requests) bad("errors cannot be more than requests")
    o.latencyMs?.let { if (!it.isFinite() || it < 0) bad("latencyMs must be a number of 0 or more") }
    o.urlStatus?.let { if (it < 0) bad("urlStatus must be an integer of 0 or more") }
}

/** Judges one observation against the checks. It is the same in every language. */
fun evaluateHealth(checks: HealthChecks, observation: HealthObservation): HealthVerdict {
    checkInputs(checks, observation)
    val failures = mutableListOf<HealthFailure>()
    val (requests, errors, latency, status) = observation
    if (checks.maxErrorRate != null && requests != null && errors != null) {
        if (requests >= maxOf(1, checks.minRequests ?: 1)) {
            val rate = errors.toDouble() / requests.toDouble()
            if (rate > checks.maxErrorRate) failures.add(HealthFailure("errorRate", rate, checks.maxErrorRate))
        }
    }
    if (checks.maxLatencyMs != null && latency != null && latency > checks.maxLatencyMs) {
        failures.add(HealthFailure("latency", latency, checks.maxLatencyMs))
    }
    if (checks.url != null && status != null && (status < 200 || status > 299)) {
        failures.add(HealthFailure("url", status.toDouble(), null))
    }
    return HealthVerdict(failures.isEmpty(), failures)
}

/**
 * Judges current and, when it fails, steps back to last on its own.
 * The rollback is recorded in history with the failed checks as the reason,
 * for example `health: errorRate, latency`. With no last the record is left
 * as it is and only the verdict says it failed.
 */
fun checkHealth(
    record: ModuleRecord,
    checks: HealthChecks,
    observation: HealthObservation,
    options: TransitionOptions = TransitionOptions(),
): HealthResult {
    val verdict = evaluateHealth(checks, observation)
    if (verdict.healthy || record.last == null) return HealthResult(record, verdict, false)
    val reason = "health: " + verdict.failures.joinToString(", ") { it.check }
    val out = rollback(record, options.copy(by = options.by ?: HEALTH_ACTOR, reason = reason))
    return HealthResult(out, verdict, true)
}
