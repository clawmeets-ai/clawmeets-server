# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/envelope.py

The frozen relay Envelope: one message, title change or close between two
deployments, signed by its sender and relayed by the hub unchanged.

The requester signs with its deployment identity key and names itself as a
``UserPrincipal``. A host signs with the agent's own key and carries that
agent's ``AgentCert``, signed by the host's identity key, which names the
agent, so a certificate for one agent cannot vouch for a reply claiming to be
another agent of the same deployment.

Files never travel inside the envelope. After the relay frame, the sender
streams each file as binary frames: a 16-byte header
(``file_stream_header``), then chunks of at most FILE_CHUNK_BYTES. The
receiver checks each file's sha256 against the signed FileRef.
"""
from __future__ import annotations

import hashlib
import re
from typing import Annotated, Any, ClassVar, Literal, Union

from pydantic import Field, StringConstraints, field_validator, model_validator

from clawmeets.hub_protocol.canonical import Purpose
from clawmeets.hub_protocol.codes import ErrorCode, WireCode
from clawmeets.hub_protocol.constants import (
    CLOCK_SKEW_S,
    FILE_HEADER_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TEXT_BYTES,
)
from clawmeets.hub_protocol.ids import (
    FINGERPRINT_PATTERN,
    AgentName,
    EpochFloat,
    EpochS,
    Fingerprint,
    HubUrl,
    MessageId,
    OpaqueId,
    PublicKeyB64,
    Sha256Hex,
    SignatureB64,
    WireModel,
    canonical_hub_url,
)

_CONVERSATION_KEY_RE = re.compile(rf"({FINGERPRINT_PATTERN})/(.+)")


class FileRef(WireModel):
    index: Annotated[int, Field(ge=0, lt=MAX_FILES)]
    name: Annotated[str, StringConstraints(min_length=1, max_length=100)]   # cleaned by the sender
    mime: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    size: Annotated[int, Field(ge=1, le=MAX_FILE_BYTES)]
    sha256: Sha256Hex


class MessageBody(WireModel):
    text: str
    files: Annotated[list[FileRef], Field(max_length=MAX_FILES)] | None = None

    @field_validator("text")
    @classmethod
    def _text_cap(cls, v: str) -> str:
        if len(v.encode("utf-8", "surrogatepass")) > MAX_TEXT_BYTES:
            raise ValueError(f"text exceeds {MAX_TEXT_BYTES} UTF-8 bytes")
        return v

    @field_validator("files")
    @classmethod
    def _unique_index(cls, v: list[FileRef] | None) -> list[FileRef] | None:
        if v is not None and len({f.index for f in v}) != len(v):
            raise ValueError("file indexes must be unique")
        return v


class TitleBody(WireModel):
    title: Annotated[str, StringConstraints(max_length=120)]


class ClosedBody(WireModel):
    reason: WireCode        # ClosedReason: requester_closed | host_closed | agent_unlisted | blocked


class AgentCert(WireModel):
    """Signed by the deployment identity key (issuer_fp) over the cert minus sig."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.AGENT_CERT

    serial: OpaqueId
    agent_name: AgentName
    agent_pubkey: PublicKeyB64
    hub_url: HubUrl
    not_after: EpochS
    issuer_fp: Fingerprint
    sig: SignatureB64 | None = None     # absent only while the issuer builds it


class UserPrincipal(WireModel):
    """The person a requester message is from.

    ``via_agent`` is set when one of that user's own agents sent it (its short
    name; the sender also keeps it to 40 characters). It is inside the signed
    envelope, so the hub can neither forge nor strip it. Absent, the bytes are
    exactly those of a sender that never knew the field; a receiver that does
    not know it ignores it. The receiver keys everything on ``user_id``, never
    on the agent, and shows the agent only as a label.
    """

    kind: Literal["user"]
    user_id: OpaqueId
    username: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    display_name: Annotated[str, StringConstraints(max_length=80)]
    via_agent: AgentName | None = None


class AgentPrincipal(WireModel):
    kind: Literal["agent"]
    agent_name: AgentName
    cert: AgentCert

    @model_validator(mode="after")
    def _cert_names_this_agent(self) -> "AgentPrincipal":
        if self.cert.agent_name != self.agent_name:
            raise ValueError("cert.agent_name must equal agent_name")
        return self


Principal = Annotated[Union[UserPrincipal, AgentPrincipal], Field(discriminator="kind")]

_BODY_FOR_TYPE: dict[str, type[WireModel]] = {
    "message": MessageBody,
    "title_change": TitleBody,
    "conversation_closed": ClosedBody,
}


class Envelope(WireModel):
    """Signed by the sender over the whole envelope minus sig (aud included)."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.ENVELOPE

    v: Annotated[int, Field(ge=1)]
    type: Literal["message", "title_change", "conversation_closed"]
    aud: HubUrl
    message_id: MessageId
    from_deployment: OpaqueId
    from_fingerprint: Fingerprint
    from_principal: Principal
    to_deployment: OpaqueId
    to_agent: AgentName | None = None           # set requester->host only
    requester_project_id: OpaqueId
    conversation_key: Annotated[str, StringConstraints(max_length=100)]
    in_reply_to: MessageId | None = None        # host->requester: the request answered
    sent_at: EpochFloat
    body: Union[MessageBody, TitleBody, ClosedBody]
    sig: SignatureB64 | None = None             # absent only while the sender builds it

    @model_validator(mode="before")
    @classmethod
    def _body_by_type(cls, data: Any) -> Any:
        # Parse body as the class its type names, not whichever union member fits.
        if isinstance(data, dict) and isinstance(data.get("body"), dict):
            body_cls = _BODY_FOR_TYPE.get(data.get("type"))  # type: ignore[arg-type]
            if body_cls is not None:
                data = {**data, "body": body_cls.model_validate(data["body"])}
        return data

    @model_validator(mode="after")
    def _shape(self) -> "Envelope":
        if not isinstance(self.body, _BODY_FOR_TYPE[self.type]):
            raise ValueError(f"body does not match type {self.type!r}")
        if (self.to_agent is not None) != (self.from_principal.kind == "user"):
            raise ValueError("to_agent is set exactly when a user (requester) sends")
        m = _CONVERSATION_KEY_RE.fullmatch(self.conversation_key)
        if not m or m.group(2) != self.requester_project_id:
            raise ValueError("conversation_key must be '<genesis fingerprint>/<requester_project_id>'")
        return self


# Structural checks only (no pins, no signature): aud is the expected hub,
# the envelope is addressed to `me`, and sent_at is within max_age_s (plus
# clock skew) in the past and at most CLOCK_SKEW_S in the future. Returns the
# first failing code, or None.
def check_envelope_frame(
    env: Envelope, *, expected_aud: str, me: str, now: float, max_age_s: int
) -> ErrorCode | None:
    if env.aud != canonical_hub_url(expected_aud):
        return ErrorCode.INVALID_SIGNATURE
    if env.to_deployment != me:
        return ErrorCode.UNKNOWN_DEPLOYMENT
    if now - env.sent_at > max_age_s + CLOCK_SKEW_S or env.sent_at - now > CLOCK_SKEW_S:
        return ErrorCode.STALE
    return None


# Binary file frame header, FILE_HEADER_BYTES long: sha256(message_id)[:14],
# then the file index as 2-byte big-endian.
def file_stream_header(message_id: str, index: int) -> bytes:
    if not 0 <= index < MAX_FILES:
        raise ValueError(f"file index must be in [0, {MAX_FILES})")
    return hashlib.sha256(message_id.encode("utf-8")).digest()[:14] + index.to_bytes(2, "big")


# Inverse of file_stream_header: (14-byte message-id hash, index). ValueError
# on a header of the wrong length or an index out of range.
def parse_file_stream_header(header: bytes) -> tuple[bytes, int]:
    if len(header) != FILE_HEADER_BYTES:
        raise ValueError(f"a file frame header is {FILE_HEADER_BYTES} bytes")
    index = int.from_bytes(header[14:], "big")
    if index >= MAX_FILES:
        raise ValueError(f"file index must be in [0, {MAX_FILES})")
    return header[:14], index
