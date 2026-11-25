package dev.versimo

enum class Channel(val id: String) { NEXT("next"), CURRENT("current"), LAST("last") }

enum class Reason { ROLLOUT, DEFAULT, NO_USER, UNHEALTHY }

/** Which version a user gets and why. [bucket] is null when there was no user id. */
data class Resolution(val version: String, val channel: Channel, val reason: Reason, val bucket: Int?)

data class HistoryEntry(
    val at: String,
    val action: String,
    val from: String?,
    val to: String?,
    val by: String? = null,
    val reason: String? = null,
)

/** The release state of one module. Records are immutable, so a transition returns a new one. */
data class ModuleRecord(
    val module: String,
    val last: String?,
    val current: String,
    val next: String?,
    val rollout: Int,
    val healthy: Boolean,
    val updatedAt: String,
    val history: List<HistoryEntry>? = null,
    val schema: String? = null,
) {
    /** The record as the plain maps and lists of the JSON format. */
    fun toMap(): Map<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        if (schema != null) m["\$schema"] = schema
        m["module"] = module
        m["last"] = last
        m["current"] = current
        m["next"] = next
        m["rollout"] = rollout.toLong()
        m["healthy"] = healthy
        m["updatedAt"] = updatedAt
        if (history != null) {
            m["history"] = history.map { e ->
                val h = LinkedHashMap<String, Any?>()
                h["at"] = e.at
                h["action"] = e.action
                h["from"] = e.from
                h["to"] = e.to
                if (e.by != null) h["by"] = e.by
                if (e.reason != null) h["reason"] = e.reason
                h
            }
        }
        return m
    }

    fun toJson(): String = Json.stringify(toMap())

    companion object {
        /** Validates [value] and builds a record. Throws [VersimoException] with INVALID_RECORD. */
        fun fromMap(value: Any?, label: String = "record"): ModuleRecord {
            val checked = validateRecord(value)
            if (!checked.ok) {
                throw VersimoException(
                    ErrorCode.INVALID_RECORD,
                    "Invalid record for \"$label\": ${checked.errors.joinToString("; ")}",
                )
            }
            val m = value as Map<*, *>
            val history = (m["history"] as List<*>?)?.map { e ->
                e as Map<*, *>
                HistoryEntry(
                    e["at"] as String,
                    e["action"] as String,
                    e["from"] as String?,
                    e["to"] as String?,
                    e["by"] as String?,
                    e["reason"] as String?,
                )
            }
            return ModuleRecord(
                module = m["module"] as String,
                last = m["last"] as String?,
                current = m["current"] as String,
                next = m["next"] as String?,
                rollout = (m["rollout"] as Number).toInt(),
                healthy = m["healthy"] as Boolean,
                updatedAt = m["updatedAt"] as String,
                history = history,
                schema = m["\$schema"] as String?,
            )
        }

        /** Parses and validates JSON text. Throws [VersimoException] with INVALID_RECORD. */
        fun fromJson(text: String, label: String = "record"): ModuleRecord {
            val parsed = try {
                Json.parse(text)
            } catch (e: Json.ParseException) {
                throw VersimoException(ErrorCode.INVALID_RECORD, "Invalid JSON for \"$label\": ${e.message}", e)
            }
            return fromMap(parsed, label)
        }
    }
}

/**
 * Options shared by the functions that change a record. [nowMillis] defaults to the current time.
 * [reason] says why the change was made and is recorded in history.
 */
data class TransitionOptions(val by: String? = null, val nowMillis: Long? = null, val reason: String? = null)
