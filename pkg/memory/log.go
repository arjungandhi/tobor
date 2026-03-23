package memory

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// LogEntry is one record written to the event log after each agent invocation.
type LogEntry struct {
	Timestamp   time.Time `json:"timestamp"`
	EventType   string    `json:"event_type"`
	RoomID      string    `json:"room_id"`
	Input       string    `json:"input"`
	ToolsCalled []string  `json:"tools_called"`
	Response    string    `json:"response"`
}

// EventLog appends LogEntry records to a gzip-compressed JSONL file using
// gzip multi-stream: each write is an independent gzip stream, so standard
// decoders read the file as a single JSONL stream.
type EventLog struct {
	mu   sync.Mutex
	path string
}

func NewEventLog(path string) *EventLog {
	return &EventLog{path: path}
}

// Append writes a single entry to the log.
func (l *EventLog) Append(entry LogEntry) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(entry); err != nil {
		return fmt.Errorf("encode log entry: %w", err)
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("flush gzip: %w", err)
	}
	return nil
}

// Prune removes entries older than retentionDays by rewriting the file.
func (l *EventLog) Prune(retentionDays int) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	entries, err := l.readAll()
	if err != nil {
		return err
	}

	var keep []LogEntry
	for _, e := range entries {
		if e.Timestamp.After(cutoff) {
			keep = append(keep, e)
		}
	}

	return l.writeAll(keep)
}

func (l *EventLog) readAll() ([]LogEntry, error) {
	f, err := os.Open(l.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open log: %w", err)
	}
	defer f.Close()

	var entries []LogEntry
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("gzip reader: %w", err)
	}
	defer gz.Close()

	dec := json.NewDecoder(gz)
	for dec.More() {
		var e LogEntry
		if err := dec.Decode(&e); err != nil {
			break // tolerate partial writes at the end
		}
		entries = append(entries, e)
	}
	return entries, nil
}

func (l *EventLog) writeAll(entries []LogEntry) error {
	f, err := os.Create(l.path)
	if err != nil {
		return fmt.Errorf("create log: %w", err)
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	for _, e := range entries {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return gz.Close()
}
