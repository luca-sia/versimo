package dev.versimo

/** Works out which version of the module this user gets, and why. A null or empty [userId] means no user. */
fun resolve(record: ModuleRecord, userId: String? = null): Resolution {
    if (!record.healthy) {
        if (record.last != null) return Resolution(record.last, Channel.LAST, Reason.UNHEALTHY, null)
        return Resolution(record.current, Channel.CURRENT, Reason.UNHEALTHY, null)
    }
    if (userId.isNullOrEmpty()) return Resolution(record.current, Channel.CURRENT, Reason.NO_USER, null)
    val bucket = bucketFor(record.module, userId)
    if (record.next != null && bucket < record.rollout) {
        return Resolution(record.next, Channel.NEXT, Reason.ROLLOUT, bucket)
    }
    return Resolution(record.current, Channel.CURRENT, Reason.DEFAULT, bucket)
}

fun resolveVersion(record: ModuleRecord, userId: String? = null): String = resolve(record, userId).version
