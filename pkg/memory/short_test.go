package memory

import (
	"testing"
	"time"

	"github.com/arjungandhi/tobor/pkg/llm"
)

func TestTrim(t *testing.T) {
	msgs := []llm.Message{
		{Role: "user", Content: "aaaa"}, // 1 token
		{Role: "assistant", Content: "bbbb"}, // 1 token
		{Role: "user", Content: "cccc"}, // 1 token
	}

	got := trim(msgs, 2)
	if len(got) != 2 {
		t.Fatalf("expected 2 messages after trim, got %d", len(got))
	}
	if got[0].Content != "bbbb" {
		t.Errorf("expected oldest message dropped, got %q", got[0].Content)
	}
}

func TestTrimEmpty(t *testing.T) {
	got := trim(nil, 100)
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %v", got)
	}
}

func TestTrimUnderBudget(t *testing.T) {
	msgs := []llm.Message{
		{Role: "user", Content: "hello"},
	}
	got := trim(msgs, 1000)
	if len(got) != 1 {
		t.Errorf("expected all messages kept, got %d", len(got))
	}
}

func TestShortTermGetEmpty(t *testing.T) {
	st := NewShortTerm(1000, time.Hour)
	msgs := st.Get("room1")
	if msgs != nil {
		t.Errorf("expected nil for unknown room, got %v", msgs)
	}
}

func TestShortTermAppendAndGet(t *testing.T) {
	st := NewShortTerm(1000, time.Hour)
	st.Append("room1", llm.Message{Role: "user", Content: "hello"})
	st.Append("room1", llm.Message{Role: "assistant", Content: "world"})

	msgs := st.Get("room1")
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Content != "hello" || msgs[1].Content != "world" {
		t.Errorf("unexpected messages: %v", msgs)
	}
}

func TestShortTermAppendTrimsBudget(t *testing.T) {
	// budget of 1 token = 4 chars; each message is "aaaa" = 1 token
	st := NewShortTerm(1, time.Hour)
	st.Append("r", llm.Message{Role: "user", Content: "aaaa"})
	st.Append("r", llm.Message{Role: "user", Content: "bbbb"})

	msgs := st.Get("r")
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message after trim, got %d", len(msgs))
	}
	if msgs[0].Content != "bbbb" {
		t.Errorf("expected newest message kept, got %q", msgs[0].Content)
	}
}

func TestShortTermIsolation(t *testing.T) {
	st := NewShortTerm(1000, time.Hour)
	st.Append("room1", llm.Message{Role: "user", Content: "a"})
	st.Append("room2", llm.Message{Role: "user", Content: "b"})

	if msgs := st.Get("room1"); len(msgs) != 1 || msgs[0].Content != "a" {
		t.Errorf("room1 contaminated: %v", msgs)
	}
	if msgs := st.Get("room2"); len(msgs) != 1 || msgs[0].Content != "b" {
		t.Errorf("room2 contaminated: %v", msgs)
	}
}

func TestShortTermGetReturnsCopy(t *testing.T) {
	st := NewShortTerm(1000, time.Hour)
	st.Append("r", llm.Message{Role: "user", Content: "original"})

	got := st.Get("r")
	got[0].Content = "mutated"

	got2 := st.Get("r")
	if got2[0].Content != "original" {
		t.Errorf("Get returned a reference to internal slice, not a copy")
	}
}
