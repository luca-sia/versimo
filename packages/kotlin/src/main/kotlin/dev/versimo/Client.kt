package dev.versimo

import java.net.HttpURLConnection

/** Returns the record for a module, or null when there is none. */
fun interface RecordSource {
    fun load(module: String): ModuleRecord?
}

class HttpResponse(val status: Int, val body: String)

/** Does one GET request. Swap it in tests, or to use another HTTP stack. */
fun interface HttpFetcher {
    fun get(url: String): HttpResponse
}

/** The default fetcher. It uses HttpURLConnection, so it works on Android. Call it off the main thread. */
class HttpUrlConnectionFetcher(private val timeoutMs: Int = 10_000) : HttpFetcher {
    override fun get(url: String): HttpResponse {
        val conn = java.net.URI(url).toURL().openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "GET"
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            val status = conn.responseCode
            if (status == 404) return HttpResponse(status, "")
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return HttpResponse(status, body)
        } finally {
            conn.disconnect()
        }
    }
}

/**
 * A source that fetches `<base>/<module>.json`. A [url] containing `{module}` has it replaced instead.
 */
class UrlSource(private val url: String, private val fetcher: HttpFetcher = HttpUrlConnectionFetcher()) : RecordSource {
    override fun load(module: String): ModuleRecord? {
        val target = if (url.contains("{module}")) url.replaceFirst("{module}", module)
        else url.trimEnd('/') + "/" + module + ".json"
        val res = try {
            fetcher.get(target)
        } catch (e: Exception) {
            throw VersimoException(ErrorCode.SOURCE_ERROR, "Could not fetch $target: ${e.message}", e)
        }
        if (res.status == 404) return null
        if (res.status !in 200..299) {
            throw VersimoException(ErrorCode.SOURCE_ERROR, "Fetching $target returned ${res.status}")
        }
        val parsed = try {
            Json.parse(res.body)
        } catch (e: Json.ParseException) {
            throw VersimoException(ErrorCode.SOURCE_ERROR, "Fetching $target returned invalid JSON: ${e.message}", e)
        }
        return ModuleRecord.fromMap(parsed, module)
    }
}

/**
 * Resolves versions from a source, with a TTL cache and stale-on-error.
 * Calls block, so on Android use a background thread or dispatcher. Safe for concurrent use.
 */
class VersimoClient(
    private val source: RecordSource,
    private val ttlMs: Long = 30_000,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private class Cached(val record: ModuleRecord, val expires: Long)

    private val cache = HashMap<String, Cached>()
    private val locks = HashMap<String, Any>()

    companion object {
        private val SLUG = Regex("[a-z0-9]+(?:-[a-z0-9]+)*")

        /** A client for a URL source. See [UrlSource]. */
        fun fromUrl(
            url: String,
            ttlMs: Long = 30_000,
            fetcher: HttpFetcher = HttpUrlConnectionFetcher(),
            clock: () -> Long = { System.currentTimeMillis() },
        ) = VersimoClient(UrlSource(url, fetcher), ttlMs, clock)
    }

    private fun load(module: String): ModuleRecord {
        val rec = source.load(module) ?: throw VersimoException(ErrorCode.NOT_FOUND, "No record for module \"$module\"")
        val checked = validateRecord(rec.toMap())
        if (!checked.ok) {
            throw VersimoException(
                ErrorCode.INVALID_RECORD,
                "Invalid record for \"$module\": ${checked.errors.joinToString("; ")}",
            )
        }
        return rec
    }

    /**
     * The cached or freshly loaded, validated record.
     * If a refresh fails with a source error and a stale record exists, the stale record is returned.
     */
    fun record(module: String): ModuleRecord {
        if (!SLUG.matches(module)) throw VersimoException(ErrorCode.INVALID_INPUT, "Invalid module slug: \"$module\"")
        // One lock per module, so concurrent callers share a single load.
        val lock = synchronized(locks) { locks.getOrPut(module) { Any() } }
        synchronized(lock) {
            val hit = synchronized(cache) { cache[module] }
            if (hit != null && hit.expires > clock()) return hit.record
            val rec = try {
                load(module)
            } catch (e: Exception) {
                val err = e as? VersimoException ?: VersimoException(ErrorCode.SOURCE_ERROR, e.message ?: "Source failed", e)
                if (hit != null && err.code == ErrorCode.SOURCE_ERROR) {
                    synchronized(cache) { cache[module] = Cached(hit.record, clock() + ttlMs) }
                    return hit.record
                }
                throw err
            }
            synchronized(cache) { cache[module] = Cached(rec, clock() + ttlMs) }
            return rec
        }
    }

    fun resolve(module: String, userId: String? = null): Resolution =
        dev.versimo.resolve(record(module), userId)

    fun version(module: String, userId: String? = null): String = resolve(module, userId).version

    /** Drops one cached record, or all of them. */
    fun clear(module: String? = null) {
        synchronized(cache) { if (module == null) cache.clear() else cache.remove(module) }
    }
}
