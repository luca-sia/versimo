package dev.versimo

import java.io.File
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull

@Suppress("UNCHECKED_CAST")
class VectorsTest {
    private val vectors = Json.parse(File("../../spec/vectors.json").readText()) as Map<String, Any?>

    private fun list(key: String) = vectors[key] as List<Map<String, Any?>>
    private fun map(v: Any?) = v as Map<String, Any?>

    @Test
    fun bucket() {
        val cases = list("bucket")
        assertEquals(true, cases.size >= 40)
        for (c in cases) {
            assertEquals((c["bucket"] as Long).toInt(), bucketFor(c["module"] as String, c["userId"] as String), c.toString())
        }
    }

    @Test
    fun resolveCases() {
        for (c in list("resolve")) {
            val r = resolve(ModuleRecord.fromMap(c["record"]), c["userId"] as String?)
            val e = map(c["expected"])
            assertEquals(e["version"], r.version, c["name"] as String)
            assertEquals(e["channel"], r.channel.id, c["name"] as String)
            assertEquals(e["reason"], r.reason.name, c["name"] as String)
            assertEquals((e["bucket"] as Long?)?.toInt(), r.bucket, c["name"] as String)
        }
    }

    @Test
    fun transitions() {
        for (c in list("transitions")) {
            val name = c["name"] as String
            val record = ModuleRecord.fromMap(c["record"])
            val args = map(c["args"])
            val opts = TransitionOptions(
                c["by"] as String?,
                Instant.parse(c["now"] as String).toEpochMilli(),
                c["reason"] as String?,
            )
            val run = {
                when (c["op"]) {
                    "promote" -> promote(record, opts)
                    "rollback" -> rollback(record, opts)
                    "setRollout" -> {
                        val n = args["n"]
                        // The Int parameter rules out a fraction at compile time.
                        if (n is Double) throw VersimoException(ErrorCode.INVALID_INPUT, "fraction")
                        setRollout(record, (n as Long).toInt(), opts)
                    }
                    "draftNext" -> draftNext(record, args["version"] as String, opts, patch = args["patch"] == true)
                    else -> error("unknown op ${c["op"]}")
                }
            }
            val error = c["error"] as String?
            if (error != null) {
                val ex = assertFailsWith<VersimoException>(name) { run() }
                assertEquals(error, ex.code.name, name)
            } else {
                val out = run()
                assertEquals(c["expected"], Json.parse(out.toJson()), name)
            }
        }
    }

    @Test
    fun validation() {
        for (c in list("validation")) {
            val name = c["name"] as String
            val r = validateRecord(c["record"])
            assertEquals(c["ok"], r.ok, name)
            assertEquals(c["errors"], r.errors.map { it.substringBefore(' ') }, name)
        }
    }

    /** Thrown when the Kotlin types rule out a vector input, such as a fraction for a count. */
    private class TypeRuledOut : RuntimeException()

    private fun num(v: Any?): Double? = when (v) {
        null -> null
        is Number -> v.toDouble()
        else -> throw TypeRuledOut()
    }

    private fun count(v: Any?): Int? = when (v) {
        null -> null
        is Long -> v.toInt()
        else -> throw TypeRuledOut()
    }

    @Test
    fun health() {
        for (c in list("health")) {
            val name = c["name"] as String
            val error = c["error"] as String?
            val ch = map(c["checks"])
            val ob = map(c["observation"])
            val checks: HealthChecks
            val obs: HealthObservation
            try {
                val url = ch["url"]
                if (url != null && url !is String) throw TypeRuledOut()
                checks = HealthChecks(num(ch["maxErrorRate"]), num(ch["maxLatencyMs"]), url as String?, count(ch["minRequests"]))
                obs = HealthObservation(count(ob["requests"]), count(ob["errors"]), num(ob["latencyMs"]), count(ob["urlStatus"]))
            } catch (e: TypeRuledOut) {
                assertEquals("INVALID_INPUT", error, "$name: input the types reject should be an error case")
                continue
            }
            val record = ModuleRecord.fromMap(c["record"])
            val opts = TransitionOptions(c["by"] as String?, Instant.parse(c["now"] as String).toEpochMilli())
            if (error != null) {
                val ex = assertFailsWith<VersimoException>(name) { checkHealth(record, checks, obs, opts) }
                assertEquals(error, ex.code.name, name)
                continue
            }
            val r = checkHealth(record, checks, obs, opts)
            val e = map(c["expected"])
            val v = map(e["verdict"])
            assertEquals(e["record"], Json.parse(r.record.toJson()), name)
            assertEquals(e["rolledBack"], r.rolledBack, name)
            assertEquals(v["healthy"], r.verdict.healthy, name)
            val want = (v["failures"] as List<Map<String, Any?>>).map {
                HealthFailure(it["check"] as String, num(it["value"])!!, num(it["limit"]))
            }
            assertEquals(want, r.verdict.failures, name)
        }
    }

    @Test
    fun semver() {
        val s = map(vectors["semver"])
        for (c in s["compare"] as List<Map<String, Any?>>) {
            assertEquals((c["expected"] as Long).toInt(), compareSemver(c["a"] as String, c["b"] as String), c.toString())
        }
        for (c in s["valid"] as List<Map<String, Any?>>) {
            assertEquals(c["valid"], isSemver(c["value"]), c.toString())
        }
    }

    @Test
    fun jsonParserBasics() {
        val parsed = Json.parse("""{"a":[1,2.5,-3e2,true,null,"xé😀\n"],"b":{}}""")
        assertNotNull(parsed)
        assertEquals(
            mapOf("a" to listOf(1L, 2.5, -300.0, true, null, "xé😀\n"), "b" to emptyMap<String, Any?>()),
            parsed,
        )
        assertFailsWith<Json.ParseException> { Json.parse("{") }
        assertFailsWith<Json.ParseException> { Json.parse("[1,]") }
        assertFailsWith<Json.ParseException> { Json.parse("1 2") }
        assertEquals("\"a\\\"b\\n\"", Json.stringify("a\"b\n"))
    }
}
