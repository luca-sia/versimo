package dev.versimo

/**
 * A small JSON reader and writer, so the library needs no dependencies.
 * Objects become Map, arrays List, integers Long, other numbers Double.
 */
internal object Json {
    class ParseException(message: String) : Exception(message)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.skipSpace()
        val value = p.value()
        p.skipSpace()
        if (!p.atEnd()) p.fail("Unexpected text after the value")
        return value
    }

    fun stringify(value: Any?): String = StringBuilder().also { write(value, it) }.toString()

    private fun write(value: Any?, out: StringBuilder) {
        when (value) {
            null -> out.append("null")
            is Boolean, is Int, is Long -> out.append(value.toString())
            is Number -> out.append(value.toString())
            is String -> quote(value, out)
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) out.append(',')
                    first = false
                    quote(k as String, out)
                    out.append(':')
                    write(v, out)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { i, v ->
                    if (i > 0) out.append(',')
                    write(v, out)
                }
                out.append(']')
            }
            else -> throw IllegalArgumentException("Cannot write ${value::class.java.name}")
        }
    }

    private fun quote(s: String, out: StringBuilder) {
        out.append('"')
        for (c in s) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u").append(String.format("%04x", c.code))
                else -> out.append(c)
            }
        }
        out.append('"')
    }

    private class Parser(private val s: String) {
        private var i = 0

        fun atEnd() = i >= s.length

        fun fail(message: String): Nothing = throw ParseException("$message at position $i")

        fun skipSpace() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
        }

        fun value(): Any? {
            if (atEnd()) fail("Unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c in '0'..'9') num() else fail("Unexpected character '$c'")
            }
        }

        private fun literal(word: String, result: Any?): Any? {
            if (!s.startsWith(word, i)) fail("Unexpected token")
            i += word.length
            return result
        }

        private fun obj(): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()
            i++
            skipSpace()
            if (i < s.length && s[i] == '}') { i++; return map }
            while (true) {
                skipSpace()
                if (atEnd() || s[i] != '"') fail("Expected a string key")
                val key = str()
                skipSpace()
                if (atEnd() || s[i] != ':') fail("Expected ':'")
                i++
                skipSpace()
                map[key] = value()
                skipSpace()
                if (atEnd()) fail("Unexpected end")
                if (s[i] == ',') { i++; continue }
                if (s[i] == '}') { i++; return map }
                fail("Expected ',' or '}'")
            }
        }

        private fun arr(): List<Any?> {
            val list = ArrayList<Any?>()
            i++
            skipSpace()
            if (i < s.length && s[i] == ']') { i++; return list }
            while (true) {
                skipSpace()
                list.add(value())
                skipSpace()
                if (atEnd()) fail("Unexpected end")
                if (s[i] == ',') { i++; continue }
                if (s[i] == ']') { i++; return list }
                fail("Expected ',' or ']'")
            }
        }

        private fun str(): String {
            val sb = StringBuilder()
            i++
            while (true) {
                if (atEnd()) fail("Unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (atEnd()) fail("Unterminated string")
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> sb.append(e)
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000c')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("Bad unicode escape")
                                val code = s.substring(i, i + 4).toIntOrNull(16) ?: fail("Bad unicode escape")
                                sb.append(code.toChar())
                                i += 4
                            }
                            else -> fail("Bad escape")
                        }
                    }
                    c < ' ' -> fail("Control character in string")
                    else -> sb.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = i
            if (s[i] == '-') i++
            val digitsStart = i
            while (i < s.length && s[i] in '0'..'9') i++
            if (i == digitsStart) fail("Bad number")
            var integral = true
            if (i < s.length && s[i] == '.') {
                integral = false
                i++
                val f = i
                while (i < s.length && s[i] in '0'..'9') i++
                if (i == f) fail("Bad number")
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                integral = false
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                val f = i
                while (i < s.length && s[i] in '0'..'9') i++
                if (i == f) fail("Bad number")
            }
            val text = s.substring(start, i)
            return if (integral) (text.toLongOrNull() ?: text.toDouble()) else text.toDouble()
        }
    }
}
