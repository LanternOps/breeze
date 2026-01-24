package filedrop

import (
	"encoding/base64"
	"encoding/json"
)

const (
	MessageTypeDropStart    = "DROP_START"
	MessageTypeDropChunk    = "DROP_CHUNK"
	MessageTypeDropComplete = "DROP_COMPLETE"
)

type Message struct {
	Type       string `json:"type"`
	TransferID string `json:"transfer_id"`
	Name       string `json:"name,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Offset     int64  `json:"offset,omitempty"`
	Data       string `json:"data,omitempty"`
}

func EncodeMessage(message Message) ([]byte, error) {
	return json.Marshal(message)
}

func DecodeMessage(data []byte) (Message, error) {
	var message Message
	return message, json.Unmarshal(data, &message)
}

func EncodeChunk(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func DecodeChunk(encoded string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(encoded)
}
