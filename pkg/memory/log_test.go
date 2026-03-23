package memory

import (
	"os"
	"testing"
	"time"
)

func TestEventLogAppendAndRead(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "log*.gz")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	log := NewEventLog(f.Name())

	entry := LogEntry{
		Timestamp: time.Now().UTC().Truncate(time.Second),
		EventType: "message",
		RoomID:    "room1",
		Input:     "hello",
		Response:  "world",
	}
	if err := log.Append(entry); err != nil {
		t.Fatalf("Append: %v", err)
	}

	entries, err := log.readAll()
	if err != nil {
		t.Fatalf("readAll: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Input != "hello" || entries[0].Response != "world" {
		t.Errorf("unexpected entry: %+v", entries[0])
	}
}

func TestEventLogAppendMultiple(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "log*.gz")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	log := NewEventLog(f.Name())

	for range 5 {
		if err := log.Append(LogEntry{
			Timestamp: time.Now().UTC(),
			EventType: "message",
			RoomID:    "r",
			Input:     "x",
		}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	entries, err := log.readAll()
	if err != nil {
		t.Fatalf("readAll: %v", err)
	}
	if len(entries) != 5 {
		t.Errorf("expected 5 entries, got %d", len(entries))
	}
}

func TestEventLogPrune(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "log*.gz")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	log := NewEventLog(f.Name())

	old := LogEntry{Timestamp: time.Now().AddDate(0, 0, -10), EventType: "old", RoomID: "r", Input: "old"}
	recent := LogEntry{Timestamp: time.Now(), EventType: "new", RoomID: "r", Input: "new"}

	if err := log.Append(old); err != nil {
		t.Fatal(err)
	}
	if err := log.Append(recent); err != nil {
		t.Fatal(err)
	}

	if err := log.Prune(5); err != nil {
		t.Fatalf("Prune: %v", err)
	}

	entries, err := log.readAll()
	if err != nil {
		t.Fatalf("readAll after prune: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry after prune, got %d", len(entries))
	}
	if entries[0].Input != "new" {
		t.Errorf("expected recent entry kept, got %q", entries[0].Input)
	}
}

func TestEventLogReadAllMissing(t *testing.T) {
	log := NewEventLog("/tmp/tobor-nonexistent-log-file.gz")
	entries, err := log.readAll()
	if err != nil {
		t.Fatalf("expected nil error for missing file, got %v", err)
	}
	if entries != nil {
		t.Errorf("expected nil entries for missing file, got %v", entries)
	}
}
