package dev.versimo

/** The outcome of [validateRecord]. Each error names the field. */
data class ValidationResult(val ok: Boolean, val errors: List<String>)

private val SLUG = Regex("[a-z0-9]+(?:-[a-z0-9]+)*")
private val DATE_TIME = Regex(
    "([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))",
)
private val ACTIONS = listOf("draft", "promote", "rollback", "rollout", "patch")
private val KEYS = setOf("\$schema", "module", "last", "current", "next", "rollout", "healthy", "updatedAt", "history")
private val ENTRY_KEYS = setOf("at", "action", "from", "to", "by")

private fun isDateTime(v: Any?): Boolean {
    if (v !is String) return false
    val g = DATE_TIME.matchEntire(v)?.groupValues ?: return false
    val month = g[2].toInt()
    val day = g[3].toInt()
    val hour = g[4].toInt()
    val minute = g[5].toInt()
    val second = g[6].toInt()
    if (month !in 1..12 || day !in 1..31 || minute > 59 || second > 59) return false
    // The reference implementation accepts 24:00:00 and any day up to 31.
    if (hour > 24 || (hour == 24 && (minute != 0 || second != 0))) return false
    if (g[8].isNotEmpty() && (g[8].toInt() > 23 || g[9].toInt() > 59)) return false
    return true
}

private fun isInt(v: Any?): Boolean = when (v) {
    is Int, is Long, is Short, is Byte -> true
    is Double -> v.isFinite() && v == Math.floor(v)
    is Float -> v.isFinite() && v == Math.floor(v.toDouble()).toFloat()
    else -> false
}

private fun checkEntry(entry: Any?, path: String, errors: MutableList<String>) {
    if (entry !is Map<*, *>) {
        errors.add("$path must be an object")
        return
    }
    for (key in entry.keys) if (key !in ENTRY_KEYS) errors.add("$path.$key is not allowed")
    if (!isDateTime(entry["at"])) errors.add("$path.at must be an ISO 8601 date-time")
    val action = entry["action"]
    if (action !is String || action !in ACTIONS) errors.add("$path.action must be one of ${ACTIONS.joinToString(", ")}")
    for (key in listOf("from", "to")) {
        val v = entry[key]
        if (!entry.containsKey(key) || (v != null && v !is String)) errors.add("$path.$key must be a string or null")
    }
    if (entry.containsKey("by") && entry["by"] !is String) errors.add("$path.by must be a string")
}

/**
 * Checks a record by hand. It never throws. Each error names the field.
 * Pass the maps and lists a JSON parser gives, or [ModuleRecord.toMap].
 */
fun validateRecord(record: Any?): ValidationResult {
    if (record !is Map<*, *>) return ValidationResult(false, listOf("record must be an object"))
    val errors = mutableListOf<String>()

    for (key in record.keys) if (key !in KEYS) errors.add("$key is not allowed")
    if (record.containsKey("\$schema") && record["\$schema"] !is String) errors.add("\$schema must be a string")
    val module = record["module"]
    if (module !is String || !SLUG.matches(module)) {
        errors.add("module must be a lower-case slug such as \"billing\" or \"sign-in\"")
    }
    val last = record["last"]
    if (!record.containsKey("last") || (last != null && !isSemver(last))) errors.add("last must be a semver string or null")
    if (!isSemver(record["current"])) errors.add("current must be a semver string")
    val next = record["next"]
    if (!record.containsKey("next") || (next != null && !isSemver(next))) errors.add("next must be a semver string or null")
    val rollout = record["rollout"]
    if (!isInt(rollout) || (rollout as Number).toDouble() < 0 || rollout.toDouble() > 100) {
        errors.add("rollout must be an integer from 0 to 100")
    }
    if (record["healthy"] !is Boolean) errors.add("healthy must be a boolean")
    if (!isDateTime(record["updatedAt"])) errors.add("updatedAt must be an ISO 8601 date-time")

    if (record.containsKey("history")) {
        val history = record["history"]
        if (history is List<*>) history.forEachIndexed { i, e -> checkEntry(e, "history[$i]", errors) }
        else errors.add("history must be an array")
    }

    if (errors.isEmpty()) {
        val current = record["current"] as String
        if (next != null && compareSemver(next as String, current) <= 0) errors.add("next must be greater than current")
        if (last != null && compareSemver(last as String, current) >= 0) errors.add("last must be lower than current")
        if (next == null && (rollout as Number).toDouble() != 0.0) errors.add("rollout must be 0 when next is null")
    }
    return ValidationResult(errors.isEmpty(), errors)
}
