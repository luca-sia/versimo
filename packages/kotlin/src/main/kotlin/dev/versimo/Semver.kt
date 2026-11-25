package dev.versimo

private const val IDENT = "(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"

/** The same expression the JSON Schema uses, without the anchors. Match it against the whole string. */
const val SEMVER_PATTERN: String =
    "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" +
        "(?:-($IDENT(?:\\.$IDENT)*))?" +
        "(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?"

private val SEMVER = Regex(SEMVER_PATTERN)

fun isSemver(value: Any?): Boolean = value is String && SEMVER.matchEntire(value) != null

private class Parsed(val core: List<String>, val pre: List<String>)

private fun parse(value: String): Parsed {
    val m = SEMVER.matchEntire(value) ?: throw IllegalArgumentException("Invalid semver: \"$value\"")
    val g = m.groupValues
    return Parsed(listOf(g[1], g[2], g[3]), if (g[4].isEmpty()) emptyList() else g[4].split("."))
}

private fun isNumeric(s: String) = s.isNotEmpty() && s.all { it in '0'..'9' }

// Numbers have no leading zeros, so length then text compares exactly, with no overflow.
private fun cmpNumeric(a: String, b: String): Int =
    if (a.length != b.length) (if (a.length < b.length) -1 else 1) else a.compareTo(b).coerceIn(-1, 1)

/** Returns -1, 0 or 1. Build metadata is ignored. Throws [IllegalArgumentException] for invalid semver. */
fun compareSemver(a: String, b: String): Int {
    val x = parse(a)
    val y = parse(b)
    for (i in 0..2) {
        val c = cmpNumeric(x.core[i], y.core[i])
        if (c != 0) return c
    }
    if (x.pre.isEmpty() && y.pre.isEmpty()) return 0
    if (x.pre.isEmpty()) return 1
    if (y.pre.isEmpty()) return -1
    for (i in 0 until maxOf(x.pre.size, y.pre.size)) {
        if (i >= x.pre.size) return -1
        if (i >= y.pre.size) return 1
        val p = x.pre[i]
        val q = y.pre[i]
        if (p == q) continue
        val pn = isNumeric(p)
        val qn = isNumeric(q)
        return when {
            pn && qn -> cmpNumeric(p, q)
            pn -> -1
            qn -> 1
            else -> p.compareTo(q).coerceIn(-1, 1)
        }
    }
    return 0
}
