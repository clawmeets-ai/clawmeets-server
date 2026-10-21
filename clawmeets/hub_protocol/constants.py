# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/constants.py

Numbers both ends of the hub protocol must agree on: the protocol version,
the default hub, size caps, ages and timing.

``clawmeets/hub_protocol/`` is the one source of truth for the hub contract.
It is imported by the server's hub client and, as a byte-identical copy, by
the private hub. It is MIT, imports only the standard library, pydantic and
cryptography, and does no I/O. Changes within a protocol version are additive
only.
"""
from __future__ import annotations

# Carried on register, auth, every frame (Frame.v) and every Envelope.v.
PROTOCOL_VERSION: int = 1
# The hub supports current and current-1; v1 has no predecessor.
MIN_SUPPORTED_VERSION: int = 1

# The operator terms a RegisterRequest.tos_version must name. The hub refuses
# any other (tos_outdated), so bumping this, with the page, makes every server
# accept the new terms on its next register or reclaim.
TOS_VERSION: str = "1"
TOS_URL: str = "https://clawmeets.ai/hub/terms"

# Already canonical (a test checks canonical_hub_url(DEFAULT_HUB_URL) is itself).
DEFAULT_HUB_URL: str = "https://hub.clawmeets.ai"

# Envelope and file caps. Enforced by the sender, the hub and the receiver.
MAX_FILE_BYTES: int = 10 * 2**20
MAX_FILES: int = 5
MAX_ENVELOPE_BYTES: int = 25 * 2**20
MAX_TEXT_BYTES: int = 32 * 1024          # UTF-8 bytes of MessageBody.text
MAX_AVATAR_BYTES: int = 256 * 1024
MAX_AVATAR_PIXELS: int = 4096            # per side
# One JSON text frame, checked before json.loads. A base64 avatar fits.
MAX_JSON_FRAME_BYTES: int = 512 * 1024
FILE_CHUNK_BYTES: int = 256 * 1024
FILE_HEADER_BYTES: int = 16

# Listing and search caps. A listing carries at most 12 capabilities of at
# most 32 characters each (design section 7); a search filters on at most as many.
MAX_CAPABILITIES: int = 12
MAX_CAPABILITY_CHARS: int = 32
MAX_SEARCH_LIMIT: int = 50
MAX_WATCH_IDS: int = 500
MAX_NOTE_CHARS: int = 500

# Ages, in seconds.
MAX_ENVELOPE_AGE_S: int = 72 * 3600
REPLY_MAX_AGE_S: int = 24 * 3600
CLOCK_SKEW_S: int = 600
STALE_EVENT_S: int = 6 * 86400
DEDUPE_RETENTION_S: int = 7 * 86400
HELD_CEILING_S: int = 7 * 86400

# Timing, in seconds.
HEARTBEAT_S: int = 20
DISCONNECTED_AFTER_S: int = 50
PROBE_INTERVAL_S: int = 6 * 3600

# Largest integer every JSON implementation round-trips exactly.
MAX_SAFE_INT: int = 2**53 - 1
# Deepest container nesting any JSON value on the wire may have. No wire object
# is deeper than 6; the cap keeps a hostile frame from exhausting the stack.
MAX_JSON_DEPTH: int = 32

# The design's startup assertion: an envelope is refused as stale before its
# event can be forgotten, so a re-relay can never look new.
assert MAX_ENVELOPE_AGE_S < STALE_EVENT_S < DEDUPE_RETENTION_S
