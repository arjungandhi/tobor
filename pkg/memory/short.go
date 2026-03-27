package memory

import (
	"sync"
	"time"

	"github.com/arjungandhi/tobor/pkg/llm"
)

// ShortTerm holds per-room conversation history with a token budget and idle
// eviction.
type ShortTerm struct {
	mu          sync.Mutex
	rooms       map[string]*roomHistory
	tokenBudget int
	idleTimeout time.Duration
}

type roomHistory struct {
	messages   []llm.Message
	lastActive time.Time
}

func NewShortTerm(tokenBudget int, idleTimeout time.Duration) *ShortTerm {
	st := &ShortTerm{
		rooms:       make(map[string]*roomHistory),
		tokenBudget: tokenBudget,
		idleTimeout: idleTimeout,
	}
	go st.reapLoop()
	return st
}

// Get returns the current message history for a room.
func (s *ShortTerm) Get(roomID string) []llm.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	rh := s.rooms[roomID]
	if rh == nil {
		return nil
	}
	out := make([]llm.Message, len(rh.messages))
	copy(out, rh.messages)
	return out
}

// Append adds messages to a room's history, then trims to the token budget.
func (s *ShortTerm) Append(roomID string, msgs ...llm.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rh := s.rooms[roomID]
	if rh == nil {
		rh = &roomHistory{}
		s.rooms[roomID] = rh
	}
	rh.messages = append(rh.messages, msgs...)
	rh.lastActive = time.Now()
	rh.messages = trim(rh.messages, s.tokenBudget)
}

// trim drops oldest messages until the total estimated token count fits within
// budget. Token count is estimated as len(text)/4.
func trim(msgs []llm.Message, budget int) []llm.Message {
	total := 0
	for _, m := range msgs {
		total += msgTokens(m)
	}
	for total > budget && len(msgs) > 0 {
		total -= msgTokens(msgs[0])
		msgs = msgs[1:]
	}
	return msgs
}

func msgTokens(m llm.Message) int {
	n := len(m.Content) / 4
	for _, tr := range m.ToolResults {
		n += len(tr.Content) / 4
	}
	for _, tc := range m.ToolCalls {
		n += len(tc.Input) / 4
	}
	return n
}

// reapLoop evicts rooms that have been idle longer than idleTimeout.
func (s *ShortTerm) reapLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for id, rh := range s.rooms {
			if now.Sub(rh.lastActive) > s.idleTimeout {
				delete(s.rooms, id)
			}
		}
		s.mu.Unlock()
	}
}
