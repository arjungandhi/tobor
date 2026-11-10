package dev.tobor.app.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ChordDeltaTest {
    private fun j(s: String): JsonElement = Json.parseToJsonElement(s)

    private fun apply(root: String?, ops: String): JsonElement? =
        ChordDelta.apply(root?.let { j(it) }, j(ops) as JsonArray)

    private fun check(root: String?, ops: String, expected: String) {
        assertEquals(j(expected), apply(root, ops))
    }

    @Test fun replaceRoot() {
        check(null, """[["r",{"a":1}]]""", """{"a":1}""")
        check("""{"x":1}""", """[["r",[1,2]]]""", "[1,2]")
    }

    @Test fun setOnObject() {
        check("""{"a":1}""", """[["s",["a"],2],["s",["b"],"x"]]""", """{"a":2,"b":"x"}""")
    }

    @Test fun setOnArrayReplaceAndAppendAtLength() {
        check("""{"xs":[1,2]}""", """[["s",["xs",0],9],["s",["xs",2],3]]""", """{"xs":[9,2,3]}""")
        assertThrows(ChordDeltaException::class.java) { apply("""{"xs":[1,2]}""", """[["s",["xs",4],3]]""") }
    }

    @Test fun deleteObjectKeyAndAbsentNoop() {
        check("""{"a":1,"b":2}""", """[["d",["a"]]]""", """{"b":2}""")
        check("""{"a":1}""", """[["d",["zzz"]]]""", """{"a":1}""")
    }

    @Test fun deleteArraySplices() {
        check("""{"xs":[1,2,3]}""", """[["d",["xs",1]]]""", """{"xs":[1,3]}""")
        assertThrows(ChordDeltaException::class.java) { apply("""{"xs":[1]}""", """[["d",["xs",1]]]""") }
    }

    @Test fun stringAppend() {
        check("""{"s":"foo"}""", """[["a",["s"],"bar"]]""", """{"s":"foobar"}""")
        assertThrows(ChordDeltaException::class.java) { apply("""{"s":1}""", """[["a",["s"],"x"]]""") }
        assertThrows(ChordDeltaException::class.java) { apply("""{}""", """[["a",["s"],"x"]]""") }
    }

    @Test fun truncateFrontIsSliceNotNumberAdd() {
        check("""{"s":"abcdef"}""", """[["t",["s"],2]]""", """{"s":"cdef"}""")
        check("""{"s":"abc"}""", """[["t",["s"],10]]""", """{"s":""}""")
        check("""{"s":"abc"}""", """[["t",["s"],0]]""", """{"s":"abc"}""")
        // a number target is an error, not an add
        assertThrows(ChordDeltaException::class.java) { apply("""{"n":5}""", """[["t",["n"],2]]""") }
    }

    @Test fun splice() {
        check("""{"xs":[1,2,3,4]}""", """[["p",["xs"],1,2,["a","b","c"]]]""", """{"xs":[1,"a","b","c",4]}""")
        check("""{"xs":[1,2]}""", """[["p",["xs"],2,0,[3,4]]]""", """{"xs":[1,2,3,4]}""")
        check("[1,2,3]", """[["p",[],0,1,[]]]""", "[2,3]")
        assertThrows(ChordDeltaException::class.java) { apply("""{"xs":{}}""", """[["p",["xs"],0,0,[]]]""") }
    }

    @Test fun permute() {
        // new[i] = old[perm[i]]
        check("""{"xs":["a","b","c"]}""", """[["m",["xs"],[2,0,1]]]""", """{"xs":["c","a","b"]}""")
        check("""["a","b","c"]""", """[["m",[],[1,2,0]]]""", """["b","c","a"]""")
        assertThrows(ChordDeltaException::class.java) { apply("""["a","b"]""", """[["m",[],[0,0]]]""") }
        assertThrows(ChordDeltaException::class.java) { apply("""["a","b"]""", """[["m",[],[0]]]""") }
    }

    @Test fun nestedMixedPaths() {
        val root = """{"entries":[{"id":1,"parts":[{"text":"hi"}]},{"id":2,"parts":[]}]}"""
        check(
            root,
            """[["a",["entries",0,"parts",0,"text"]," there"],
                ["p",["entries",1,"parts"],0,0,[{"text":"new"}]],
                ["s",["entries",1,"id"],20],
                ["t",["entries",0,"parts",0,"text"],3]]""",
            """{"entries":[{"id":1,"parts":[{"text":"there"}]},{"id":20,"parts":[{"text":"new"}]}]}""",
        )
    }

    @Test fun doesNotMutateInput() {
        val before = j("""{"xs":[1,2],"s":"a"}""")
        val after = ChordDelta.apply(before, j("""[["s",["xs",0],5],["a",["s"],"b"]]""") as JsonArray)
        assertEquals(j("""{"xs":[1,2],"s":"a"}"""), before)
        assertEquals(j("""{"xs":[5,2],"s":"ab"}"""), after)
    }

    @Test fun rejectsBadInput() {
        assertThrows(ChordDeltaException::class.java) { apply("{}", """[["s",["__proto__","x"],1]]""") }
        assertThrows(IllegalArgumentException::class.java) { apply("{}", """[["z",["a"]]]""") }
        assertThrows(ChordDeltaException::class.java) { apply(null, """[["s",["a"],1]]""") }
        assertThrows(ChordDeltaException::class.java) { apply("""{}""", """[["s",["a","b"],1]]""") }
    }
}
