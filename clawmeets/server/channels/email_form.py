# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_form.py
Reading SendGrid's Inbound Parse POST as a stream, with every limit stated.

SendGrid takes messages of up to 30 MB and re-encodes them as
``multipart/form-data``, so the POST is larger than the message; nginx stops
anything over 40 MiB, and this reader is the second line (and the only one in
tests). Starlette's ``request.form()`` is not used: its defaults (1 MB per text
field, 1000 parts) would refuse a 2 MB plain-text mail with a 400, which
SendGrid then retries for three days, and it spools every attachment to disk.

The limits:

- **total body**: ``MAX_EMAIL_BODY_BYTES`` (40 MiB, as nginx), counted as the
  chunks arrive, whether or not ``Content-Length`` was declared → 413;
- **text fields**: only the fields the adapter reads are kept, each up to its
  own cap (``text``/``html`` 4 MiB, ``headers`` 1 MiB, the rest 64 KiB). A
  longer value is CUT and recorded in ``InboundForm.truncated`` — never
  refused, so the sender's message still arrives. Every other field is read
  and thrown away;
- **file parts** (attachments, inline images): never kept, in memory or on
  disk. Only the name, type and byte count are recorded, so no temp file can
  be left behind on any path;
- **parts**: at most ``MAX_PARTS``; more → :class:`FormLimit` (answered 200,
  dropped: a retry would hit the same limit);
- **part headers**: python-multipart's own bounds (8 headers, 4 KiB each).

A malformed body (no boundary, broken framing, the stream ending before the
closing boundary) is :class:`FormInvalid`. Neither exception carries
python-multipart's own message, which can quote header bytes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

from python_multipart.multipart import MultipartParser, parse_options_header
from python_multipart.exceptions import MultipartParseError

MAX_EMAIL_BODY_BYTES = 40 * 1024 * 1024
MAX_PARTS = 250
SMALL_FIELD_BYTES = 64 * 1024
FIELD_LIMITS = {
    "text": 4 * 1024 * 1024,
    "html": 4 * 1024 * 1024,
    "headers": 1024 * 1024,
    "dkim": SMALL_FIELD_BYTES,
    "to": SMALL_FIELD_BYTES,
    "cc": SMALL_FIELD_BYTES,
    "from": SMALL_FIELD_BYTES,
    "subject": SMALL_FIELD_BYTES,
    "envelope": SMALL_FIELD_BYTES,
    "charsets": SMALL_FIELD_BYTES,
    "SPF": SMALL_FIELD_BYTES,
    "spam_score": SMALL_FIELD_BYTES,
    "attachments": SMALL_FIELD_BYTES,
    "attachment-info": SMALL_FIELD_BYTES,
}


class FormTooLarge(Exception):
    """The body is over ``MAX_EMAIL_BODY_BYTES`` (413)."""


class FormInvalid(Exception):
    """Not a readable multipart body (200, dropped)."""


class FormLimit(Exception):
    """A parse limit was hit (200, dropped)."""


@dataclass(frozen=True)
class FilePart:
    field: str
    filename: str
    content_type: str
    size: int


@dataclass
class InboundForm:
    fields: dict[str, bytes] = field(default_factory=dict)
    truncated: set[str] = field(default_factory=set)
    files: list[FilePart] = field(default_factory=list)
    #: Bytes read from the stream (tests check the reader stopped at the cap).
    bytes_read: int = 0


class _Collector:
    def __init__(self, form: InboundForm, field_limits: dict[str, int]) -> None:
        self.form = form
        self.field_limits = field_limits
        self.parts = 0
        self.ended = False
        self._header_field = bytearray()
        self._header_value = bytearray()
        self._headers: dict[bytes, bytes] = {}
        self._name: Optional[str] = None
        self._filename: Optional[str] = None
        self._content_type = ""
        self._buffer: Optional[bytearray] = None
        self._limit = 0
        self._size = 0

    def callbacks(self) -> dict:
        return {
            "on_part_begin": self.on_part_begin,
            "on_header_field": self.on_header_field,
            "on_header_value": self.on_header_value,
            "on_header_end": self.on_header_end,
            "on_headers_finished": self.on_headers_finished,
            "on_part_data": self.on_part_data,
            "on_part_end": self.on_part_end,
            "on_end": self.on_end,
        }

    def on_part_begin(self) -> None:
        self.parts += 1
        if self.parts > MAX_PARTS:
            raise FormLimit()
        self._headers = {}
        self._name = self._filename = None
        self._content_type = ""
        self._buffer = None
        self._size = 0

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._header_field += data[start:end]

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._header_value += data[start:end]

    def on_header_end(self) -> None:
        self._headers[bytes(self._header_field).strip().lower()] = bytes(self._header_value).strip()
        self._header_field = bytearray()
        self._header_value = bytearray()

    def on_headers_finished(self) -> None:
        _, options = parse_options_header(self._headers.get(b"content-disposition", b""))
        name = options.get(b"name")
        self._name = name.decode("utf-8", errors="replace") if name is not None else None
        filename = options.get(b"filename")
        self._filename = filename.decode("utf-8", errors="replace") if filename is not None else None
        ctype, _ = parse_options_header(self._headers.get(b"content-type", b""))
        self._content_type = ctype.decode("latin-1", errors="replace")
        if self._filename is None and self._name in self.field_limits:
            self._buffer = bytearray()
            self._limit = self.field_limits[self._name]

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        self._size += end - start
        if self._buffer is None:
            return  # an attachment or a field nobody reads: counted, not kept
        room = self._limit - len(self._buffer)
        if room > 0:
            self._buffer += data[start:min(end, start + room)]
        if end - start > room and self._name is not None:
            self.form.truncated.add(self._name)

    def on_part_end(self) -> None:
        if self._filename is not None:
            self.form.files.append(FilePart(
                field=self._name or "", filename=self._filename,
                content_type=self._content_type, size=self._size,
            ))
        elif self._buffer is not None and self._name is not None:
            self.form.fields[self._name] = bytes(self._buffer)
        self._buffer = None

    def on_end(self) -> None:
        self.ended = True


def boundary_of(content_type: Optional[str]) -> bytes:
    ctype, options = parse_options_header(content_type or "")
    boundary = options.get(b"boundary")
    if ctype != b"multipart/form-data" or not boundary or len(boundary) > 200:
        raise FormInvalid()
    return boundary


async def read_inbound_form(
    content_type: Optional[str], stream: AsyncIterator[bytes], *,
    max_bytes: int = MAX_EMAIL_BODY_BYTES, field_limits: Optional[dict[str, int]] = None,
) -> InboundForm:
    """Parse the POST from ``stream`` without ever holding it whole.
    ``field_limits`` names the fields kept and their caps (SendGrid's
    ``FIELD_LIMITS`` by default; Mailgun's are in ``email_mailgun``).

    Raises :class:`FormTooLarge`, :class:`FormInvalid` or :class:`FormLimit`.
    """
    boundary = boundary_of(content_type)
    form = InboundForm()
    collector = _Collector(form, FIELD_LIMITS if field_limits is None else field_limits)
    parser = MultipartParser(boundary, collector.callbacks())
    try:
        async for chunk in stream:
            if not chunk:
                continue
            form.bytes_read += len(chunk)
            if form.bytes_read > max_bytes:
                raise FormTooLarge()
            parser.write(chunk)
        parser.finalize()
    except (FormTooLarge, FormLimit):
        raise
    except (MultipartParseError, ValueError, LookupError):
        raise FormInvalid() from None
    if not collector.ended:
        raise FormInvalid()
    return form


async def read_urlencoded_form(
    stream: AsyncIterator[bytes], *, max_bytes: int = MAX_EMAIL_BODY_BYTES,
    field_limits: dict[str, int],
) -> InboundForm:
    """An ``application/x-www-form-urlencoded`` POST (Mailgun sends one when a
    message has no attachments) read into the same :class:`InboundForm`,
    under the same total cap and field caps. Raises :class:`FormTooLarge`."""
    from urllib.parse import parse_qsl

    form = InboundForm()
    body = bytearray()
    async for chunk in stream:
        form.bytes_read += len(chunk)
        if form.bytes_read > max_bytes:
            raise FormTooLarge()
        body += chunk
    for name, value in parse_qsl(
        bytes(body).decode("latin-1"), keep_blank_values=True, encoding="latin-1",
    ):
        if name not in field_limits:
            continue
        raw = value.encode("latin-1")
        if len(raw) > field_limits[name]:
            raw = raw[:field_limits[name]]
            form.truncated.add(name)
        form.fields[name] = raw
    return form
