package dev.versimo

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private fun stamp(options: TransitionOptions): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date(options.nowMillis ?: System.currentTimeMillis()))
}

private fun apply(
    record: ModuleRecord,
    action: String,
    from: String?,
    to: String?,
    options: TransitionOptions,
    change: (ModuleRecord, String) -> ModuleRecord,
): ModuleRecord {
    val at = stamp(options)
    val entry = HistoryEntry(at, action, from, to, options.by, options.reason)
    return change(record, at).copy(updatedAt = at, history = (record.history ?: emptyList()) + entry)
}

private fun invalid(message: String) = VersimoException(ErrorCode.INVALID_INPUT, message)

/** Sets a new next version at 0% rollout. It replaces any next already drafted. */
fun draftNext(
    record: ModuleRecord,
    version: String,
    options: TransitionOptions = TransitionOptions(),
    patch: Boolean = false,
): ModuleRecord {
    if (!isSemver(version)) throw invalid("Invalid semver: $version")
    if (compareSemver(version, record.current) <= 0) {
        throw invalid("Next $version must be greater than current ${record.current}")
    }
    return apply(record, if (patch) "patch" else "draft", record.next ?: record.current, version, options) { r, _ ->
        r.copy(next = version, rollout = 0)
    }
}

/** Moves next to current and current to last. Rollout resets to 0. */
fun promote(record: ModuleRecord, options: TransitionOptions = TransitionOptions()): ModuleRecord {
    val next = record.next ?: throw invalid("Nothing to promote: next is empty")
    return apply(record, "promote", record.current, next, options) { r, _ ->
        r.copy(last = r.current, current = next, next = null, rollout = 0, healthy = true)
    }
}

/**
 * Puts last back as current. The failed version and any drafted next are dropped,
 * so there is nothing left to roll back to until the next promote.
 */
fun rollback(record: ModuleRecord, options: TransitionOptions = TransitionOptions()): ModuleRecord {
    val last = record.last ?: throw invalid("Nothing to roll back to: last is empty")
    return apply(record, "rollback", record.current, last, options) { r, _ ->
        r.copy(last = null, current = last, next = null, rollout = 0, healthy = true)
    }
}

/** Sets the share of users on next, an integer from 0 to 100. */
fun setRollout(record: ModuleRecord, n: Int, options: TransitionOptions = TransitionOptions()): ModuleRecord {
    if (n < 0 || n > 100) throw invalid("Rollout must be an integer from 0 to 100")
    if (n > 0 && record.next == null) throw invalid("Cannot roll out: next is empty")
    return apply(record, "rollout", record.rollout.toString(), n.toString(), options) { r, _ -> r.copy(rollout = n) }
}
