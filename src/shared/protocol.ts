// The wire format, shared by the server and every client: each WebSocket
// message starts with a varint message type, then the body.
//
//   MSG_SYNC       the Yjs sync protocol (y-protocols/sync):
//                    step 1  "here's my state vector" (what I've seen)
//                    step 2  "here's everything you're missing"
//                    update  "here's a change I just made"
//   MSG_AWARENESS  who's here and where their cursor is (y-protocols/awareness).
//                  Not stored: presence is live-only.

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1

export const ROOM_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
