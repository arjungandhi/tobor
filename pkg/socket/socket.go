package socket

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"time"
)

// Event is the common JSON format for all events written to the socket.
type Event struct {
	Type      string    `json:"type"` // "message" | "reminder" | "poll"
	RoomID    string    `json:"room_id"`
	Sender    string    `json:"sender"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
}

// Listener accepts connections on a Unix domain socket and emits Events.
type Listener struct {
	path string
}

func New(path string) *Listener {
	return &Listener{path: path}
}

// Listen opens the socket and calls handler for each received event.
// Blocks until ctx is done or a fatal error occurs.
func (l *Listener) Listen(handler func(Event)) error {
	if err := os.Remove(l.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove old socket: %w", err)
	}

	ln, err := net.Listen("unix", l.path)
	if err != nil {
		return fmt.Errorf("listen %s: %w", l.path, err)
	}
	defer ln.Close()

	for {
		conn, err := ln.Accept()
		if err != nil {
			return fmt.Errorf("accept: %w", err)
		}
		go readEvents(conn, handler)
	}
}

func readEvents(conn net.Conn, handler func(Event)) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		var ev Event
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			continue // skip malformed lines
		}
		handler(ev)
	}
}
