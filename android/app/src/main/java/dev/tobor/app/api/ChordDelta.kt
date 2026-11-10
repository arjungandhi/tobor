package dev.tobor.app.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** An op that is malformed or cannot be applied to the current value. Callers treat it as "resync from a snapshot". */
class ChordDeltaException(message: String) : IllegalArgumentException(message)

/**
 * Kotlin port of chord's delta applier (`@earendil-works/chord/dist/delta/index.js`: `assertValidOp`, `applyOps`,
 * `copyContainers`, `resolve`; the node uses `applyImmutable`). Values are kotlinx [JsonElement] trees and are never
 * mutated; every touched container is copied along the path (structural sharing for the rest).
 *
 * Op tuples (decoded form: the node sends inline paths, no `#` interning, no short forms):
 *
 *     ["r", value]                       replace root
 *     ["s", path, value]                 set            (path non-empty)
 *     ["d", path]                        delete         (path non-empty)
 *     ["a", path, string]                string append  (path non-empty)
 *     ["t", path, n]                     string TRUNCATE-FRONT, NOT a number add (path non-empty, n integer >= 0)
 *     ["p", path, start, del, items]     array splice   (path may be empty = root)
 *     ["m", path, permutation]           array permute  (path may be empty = root)
 *
 * Path segments are strings (object keys) or non-negative integers (array indexes; on an object an integer is the
 * string key). Strings `__proto__`, `constructor`, `prototype` are rejected (kept for parity, harmless here).
 *
 * Every failure throws [ChordDeltaException] (an [IllegalArgumentException]).
 */
object ChordDelta {

    /**
     * Apply [ops] in order to [root] and return the new root. [root] may be null (JS `undefined`, i.e. no snapshot
     * yet); only an `r` op can fix that, anything else throws. On a throw nothing is returned, so the caller's old
     * value stays intact (the JS `applyImmutable` is also all-or-nothing from the caller's view).
     */
    fun apply(root: JsonElement?, ops: JsonArray): JsonElement? {
        var current: JsonElement? = root
        for (opEl in ops) {
            val op = opEl as? JsonArray ?: fail("op is not a tuple") // JS: "op is not a tuple"
            if (op.isEmpty()) fail("op is not a tuple")
            val verb = (op[0] as? JsonPrimitive)?.takeIf { it.isString }?.content
            when (verb) {
                // JS: if (op[0] === "r") { if (op.length !== 2) throw ...; root = op[1]; continue; }
                // "Adopted, not copied." The whole value is replaced.
                "r" -> {
                    if (op.size != 2) fail("r arity")
                    current = op[1]
                }

                // JS: case "s": write(op[2]);  where write = defineProperty(parent, key, {value,...})
                // and, before that: if (Array.isArray(parent)) { if (typeof key !== "number") throw UnsafePathError;
                //   assertIndexInRange(parent, key) }   // index > parent.length throws; == length appends
                // The parent (`resolve(root, path.slice(0, -1))`) must exist and be a container. Setting a missing
                // object key creates it; intermediate containers are NEVER created.
                "s" -> {
                    if (op.size != 3) fail("s arity")
                    val path = parsePath(op[1], nonEmpty = true)
                    current = update(current, path, path.size - 1, path) { parent -> setKey(parent, path.last(), op[2], path) }
                }

                // JS: case "d": if (Array.isArray(parent)) { if (typeof key !== "number" || key >= parent.length)
                //   throw new PathError(path); parent.splice(key, 1); } else delete parent[key];
                // Arrays shift left; deleting an absent object key is a silent no-op.
                "d" -> {
                    if (op.size != 2) fail("d arity")
                    val path = parsePath(op[1], nonEmpty = true)
                    current = update(current, path, path.size - 1, path) { parent -> deleteKey(parent, path.last(), path) }
                }

                // JS: case "a": { const current = read(); if (typeof current !== "string") throw new PathError(path);
                //   write(`${current}${op[2]}`); }   // read = Object.hasOwn(parent,key) ? parent[key] : undefined
                "a" -> {
                    if (op.size != 3 || (op[2] as? JsonPrimitive)?.isString != true) fail("a shape")
                    val path = parsePath(op[1], nonEmpty = true)
                    val suffix = (op[2] as JsonPrimitive).content
                    current = update(current, path, path.size - 1, path) { parent ->
                        val old = readString(parent, path.last(), path)
                        setKey(parent, path.last(), JsonPrimitive(old + suffix), path)
                    }
                }

                // JS: case "t": { const current = read(); if (typeof current !== "string") throw new PathError(path);
                //   write(current.slice(op[2])); }  and assertValidOp: `!Number.isInteger(op[2]) || op[2] < 0`
                // i.e. "t" DROPS the first n UTF-16 units of the string (slice(n) clamps at the length). It is not
                // the number-add some descriptions claim.
                "t" -> {
                    if (op.size != 3) fail("t shape")
                    val n = nonNegInt(op[2], "t shape")
                    val path = parsePath(op[1], nonEmpty = true)
                    current = update(current, path, path.size - 1, path) { parent ->
                        val old = readString(parent, path.last(), path)
                        setKey(parent, path.last(), JsonPrimitive(old.substring(minOf(n, old.length))), path)
                    }
                }

                // JS: const target_ = path.length === 0 ? root : resolve(root, path);
                //   if (!Array.isArray(target_)) throw new PathError(path);
                //   target_.splice(op[2], op[3]);                       // delete first (start/count clamp like JS)
                //   target_.splice(op[2] + offset, 0, ...items chunk)   // then insert at op[2] (clamped to length)
                // assertValidOp: index and remove are integers >= 0, items is an array.
                "p" -> {
                    if (op.size != 5) fail("p arity")
                    val path = parsePath(op[1], nonEmpty = false)
                    val start = nonNegInt(op[2], "p index")
                    val remove = nonNegInt(op[3], "p remove")
                    val items = op[4] as? JsonArray ?: fail("p items")
                    current = update(current, path, path.size, path) { target ->
                        val list = target as? JsonArray ?: pathError(path)
                        val m = ArrayList<JsonElement>(list)
                        val s = minOf(start, m.size)
                        m.subList(s, s + minOf(remove, m.size - s)).clear() // splice(start, remove)
                        m.addAll(minOf(start, m.size), items) // splice(start, 0, ...items), start clamped again
                        JsonArray(m)
                    }
                }

                // JS: if (!Array.isArray(target_) || target_.length !== op[2].length) throw new PathError(path);
                //   const previous = target_.slice();
                //   for (index...) target_[index] = previous[op[2][index]];          // new[i] = old[perm[i]]
                // assertPermutation: every entry an integer in [0, len) and each used exactly once (a bijection).
                "m" -> {
                    if (op.size != 3) fail("m arity")
                    val path = parsePath(op[1], nonEmpty = false)
                    val permEl = op[2] as? JsonArray ?: fail("m permutation is not an array")
                    val perm = IntArray(permEl.size)
                    val seen = BooleanArray(permEl.size)
                    for (i in permEl.indices) {
                        val v = integer(permEl[i])
                        if (v == null || v < 0 || v >= permEl.size || seen[v.toInt()]) fail("m permutation is not a bijection")
                        perm[i] = v.toInt()
                        seen[v.toInt()] = true
                    }
                    current = update(current, path, path.size, path) { target ->
                        val list = target as? JsonArray ?: pathError(path)
                        if (list.size != perm.size) pathError(path)
                        JsonArray(List(perm.size) { list[perm[it]] })
                    }
                }

                // JS: default: throw new TypeError(`unknown op verb: ${String(op[0])}`)
                // "Silently skipping an unknown verb is how a newer producer's op vanishes."
                else -> throw IllegalArgumentException("unknown op verb: ${op[0]}")
            }
        }
        return current
    }

    // ─── Path walking ────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * Copy-on-write walk: follows `path[0 until depth]` from [node] and replaces the container reached with
     * `leaf(container)`. JS `resolveValue`: each step requires the current node to be a container (object/array, not
     * null/primitive), an array step to use an integer segment, and the key to be an OWN property / existing index —
     * otherwise `PathError`. With depth 0 the leaf gets the root itself (`path.length === 0 ? root : resolve(...)`).
     * A null/absent root fails `isObj` for the final container check.
     */
    private fun update(
        node: JsonElement?,
        path: List<Any>,
        depth: Int,
        fullPath: List<Any>,
        leaf: (JsonElement) -> JsonElement,
    ): JsonElement {
        // iterative-free recursion; depth is the path length (small)
        fun go(n: JsonElement?, i: Int): JsonElement {
            if (n == null || n is JsonNull || n is JsonPrimitive) pathError(fullPath) // !isObj
            if (i == depth) return leaf(n)
            val seg = path[i]
            return when (n) {
                is JsonObject -> {
                    val key = seg.toString()
                    val child = n[key] ?: pathError(fullPath) // !Object.hasOwn
                    val copy = LinkedHashMap<String, JsonElement>(n)
                    copy[key] = go(child, i + 1)
                    JsonObject(copy)
                }
                is JsonArray -> {
                    if (seg !is Int) throw ChordDeltaException("unsafe path segment: $seg")
                    if (seg >= n.size) pathError(fullPath)
                    val copy = ArrayList<JsonElement>(n)
                    copy[seg] = go(n[seg], i + 1)
                    JsonArray(copy)
                }
                else -> pathError(fullPath)
            }
        }
        return go(node, 0)
    }

    private fun setKey(parent: JsonElement, key: Any, value: JsonElement, path: List<Any>): JsonElement = when (parent) {
        is JsonObject -> JsonObject(LinkedHashMap<String, JsonElement>(parent).also { it[key.toString()] = value })
        is JsonArray -> {
            if (key !is Int) throw ChordDeltaException("unsafe path segment: $key")
            // assertIndexInRange: index > length throws; index == length appends exactly one.
            if (key > parent.size) throw ChordDeltaException("unsafe path segment: $key")
            val copy = ArrayList<JsonElement>(parent)
            if (key == parent.size) copy.add(value) else copy[key] = value
            JsonArray(copy)
        }
        else -> pathError(path)
    }

    private fun deleteKey(parent: JsonElement, key: Any, path: List<Any>): JsonElement = when (parent) {
        is JsonObject -> JsonObject(LinkedHashMap<String, JsonElement>(parent).also { it.remove(key.toString()) })
        is JsonArray -> {
            if (key !is Int) throw ChordDeltaException("unsafe path segment: $key")
            if (key >= parent.size) pathError(path)
            JsonArray(ArrayList<JsonElement>(parent).also { it.removeAt(key) })
        }
        else -> pathError(path)
    }

    /** JS `read()`: own property or undefined; callers require a string. */
    private fun readString(parent: JsonElement, key: Any, path: List<Any>): String {
        val value: JsonElement? = when (parent) {
            is JsonObject -> parent[key.toString()]
            is JsonArray -> {
                if (key !is Int) throw ChordDeltaException("unsafe path segment: $key")
                if (key > parent.size) throw ChordDeltaException("unsafe path segment: $key")
                parent.getOrNull(key)
            }
            else -> null
        }
        val p = value as? JsonPrimitive
        if (p == null || p is JsonNull || !p.isString) pathError(path)
        return p.content
    }

    // ─── Validation (assertValidOp / assertSafePath) ─────────────────────────────────────────────────────────────

    /**
     * JS `assertPathArg` + `assertSafePath`: path is an array (non-empty for s/d/a/t); string segments must not be
     * `__proto__`/`constructor`/`prototype`; non-string segments must be non-negative integers.
     */
    private fun parsePath(el: JsonElement, nonEmpty: Boolean): List<Any> {
        val arr = el as? JsonArray ?: fail("path is not an array")
        if (nonEmpty && arr.isEmpty()) fail("path is empty")
        return arr.map { seg ->
            val p = seg as? JsonPrimitive
            when {
                p == null || p is JsonNull -> throw ChordDeltaException("unsafe path segment: $seg")
                p.isString -> {
                    if (p.content in RESERVED) throw ChordDeltaException("unsafe path segment: ${p.content}")
                    p.content
                }
                else -> {
                    val v = integer(p)
                    if (v == null || v < 0 || v > Int.MAX_VALUE) throw ChordDeltaException("unsafe path segment: $seg")
                    v.toInt()
                }
            }
        }
    }

    /** `Number.isInteger`: numeric (non-string) primitive with an integral value. */
    private fun integer(el: JsonElement): Long? {
        val p = el as? JsonPrimitive ?: return null
        if (p is JsonNull || p.isString) return null
        p.content.toLongOrNull()?.let { return it }
        val d = p.content.toDoubleOrNull() ?: return null
        return if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 9.0e15) d.toLong() else null
    }

    /** Integer >= 0, clamped to Int.MAX_VALUE (every use is a clamped index/length). */
    private fun nonNegInt(el: JsonElement, what: String): Int {
        val v = integer(el)
        if (v == null || v < 0) fail(what)
        return if (v > Int.MAX_VALUE) Int.MAX_VALUE else v.toInt()
    }

    private val RESERVED = setOf("__proto__", "constructor", "prototype")

    private fun fail(msg: String): Nothing = throw ChordDeltaException(msg)

    private fun pathError(path: List<Any>): Nothing =
        throw ChordDeltaException("unresolvable path: " + path.joinToString(prefix = "[", postfix = "]") {
            if (it is String) "\"$it\"" else it.toString()
        })
}
