package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// MaxFrameBytes caps one NDJSON frame. Transcript events are the largest
// frames on the wire (base64 images, full tool results); 64 MiB leaves room
// without letting a broken peer exhaust memory.
const MaxFrameBytes = 64 << 20

// Reader decodes newline-delimited JSON frames.
type Reader struct {
	scanner *bufio.Scanner
}

// NewReader wraps r in an NDJSON frame reader.
func NewReader(r io.Reader) *Reader {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), MaxFrameBytes)
	return &Reader{scanner: sc}
}

// Next returns the next non-empty frame, or io.EOF.
func (r *Reader) Next() (Frame, error) {
	for r.scanner.Scan() {
		line := bytes.TrimSpace(r.scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		return DecodeFrame(line)
	}
	if err := r.scanner.Err(); err != nil {
		return Frame{}, err
	}
	return Frame{}, io.EOF
}

// Writer encodes frames as one JSON object per line.
//
// Writes are serialized: a gateway streams events from several worker
// goroutines and interleaved partial writes would corrupt the stream.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

// NewWriter wraps w in an NDJSON frame writer.
func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

// Write marshals v and appends a newline.
//
// Events must use WriteEvent: an Event marshals to the params object, not to a
// full frame, and writing it here would produce a frame the peer cannot decode.
func (w *Writer) Write(v any) error {
	switch v.(type) {
	case Event, *Event:
		return fmt.Errorf("protocol: use WriteEvent for events")
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return w.WriteRaw(data)
}

// WriteEvent emits a complete event frame:
//
//	{"jsonrpc":"2.0","method":"event","params":{...Event...}}
func (w *Writer) WriteEvent(ev Event) error {
	params, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	return w.Write(eventFrame{
		JSONRPC: Version,
		Method:  EventMethod,
		Params:  params,
	})
}

type eventFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// WriteRaw appends a newline to an already-encoded frame.
func (w *Writer) WriteRaw(data []byte) error {
	buf := make([]byte, 0, len(data)+1)
	buf = append(buf, data...)
	buf = append(buf, '\n')

	w.mu.Lock()
	defer w.mu.Unlock()
	_, err := w.w.Write(buf)
	return err
}
