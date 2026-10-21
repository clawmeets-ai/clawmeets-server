# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/email.py
ClawMeets-domain email factories: project/agent/chatroom-aware templates that
produce ``ClawMeetsEmailMessage`` instances for the generic ``Mailer``.
"""
from __future__ import annotations

import html as _html
import os
import re
from typing import TYPE_CHECKING, Optional
from urllib.parse import quote

from ..utils.email import EmailAttachment, EmailMessage

if TYPE_CHECKING:
    from ..models.project import Project

_COLOR_ACCENT = "#9333ea"  # tailwind purple-600 — matches utils/email.py CTA

VERIFICATION_BASE_URL = os.environ.get(
    "CLAWMEETS_VERIFICATION_URL", "https://clawmeets.ai"
)
APP_BASE_URL = os.environ.get("CLAWMEETS_APP_URL", VERIFICATION_BASE_URL)

_GENERIC_ROLES = {"assistant", "agent", "bot", "helper"}


def _title_part(part: str) -> str:
    """Title-case a token; treat short consonant-only tokens as acronyms."""
    if len(part) <= 3 and not re.search(r"[aeiouAEIOU]", part):
        return part.upper()
    return part.capitalize()


class ClawMeetsEmailMessage(EmailMessage):
    """ClawMeets-domain email factories.

    Inherits the value-object fields and agnostic rendering primitives
    (``strip_markdown``, ``first_sentence``, ``render_notification_html``,
    …) from :class:`~clawmeets.utils.email.EmailMessage`. Adds domain
    helpers (agent-name humanization, chatroom/project URL builders) and
    factory classmethods that compose the lot into a finished message
    ready to hand to ``get_mailer().send(...)``.
    """

    # ------------------------------------------------------------------
    # Domain helpers
    # ------------------------------------------------------------------

    @staticmethod
    def humanize_agent_name(name: str, username: Optional[str] = None) -> str:
        """Turn slugs like ``chuswine-bc`` into ``BC`` or ``Chuswine BC``.

        If the slug is prefixed with the username (common when agents
        belong to a user), strip the redundant prefix — unless what's
        left is a generic role word like ``assistant``, in which case
        keep the prefix so the result stays recognizable
        (``Chuswine Assistant``).
        """
        if not name:
            return "your agent"
        display = name
        if username:
            pref = f"{username}-"
            if display.lower().startswith(pref.lower()) and len(display) > len(pref):
                remainder = display[len(pref):]
                if remainder.lower() not in _GENERIC_ROLES:
                    display = remainder
        parts = re.split(r"[-_\s]+", display)
        titled = " ".join(_title_part(p) for p in parts if p)
        return titled or name

    @staticmethod
    def chatroom_url(app_base_url: str, project_id: str, chatroom_name: str) -> str:
        base = app_base_url.rstrip("/")
        return f"{base}/app/projects/{project_id}/chatrooms/{quote(chatroom_name, safe='')}"

    @staticmethod
    def project_url(app_base_url: str, project_id: str) -> str:
        return f"{app_base_url.rstrip('/')}/app/projects/{project_id}"

    @staticmethod
    def report_url(app_base_url: str, project_id: str) -> str:
        """Deep link to the project's Report tab (``?tab=report``)."""
        return (
            f"{ClawMeetsEmailMessage.project_url(app_base_url, project_id)}"
            f"?tab=report"
        )

    @staticmethod
    def _assets_block(
        report_url: Optional[str],
        attachments: Optional[list[EmailAttachment]],
        skipped: Optional[list[str]] = None,
    ) -> tuple[Optional[str], str]:
        """Build the shared report-link + attachment note.

        Returns ``(extra_html, plain_suffix)`` for splicing into a
        notification's HTML (``render_notification_html(extra_html=...)``)
        and its plain-text body. Either part is empty when there is no
        report link and no attachment.
        """
        html_parts: list[str] = []
        plain_parts: list[str] = []
        n = len(attachments or [])
        if n:
            noun = "file" if n == 1 else "files"
            html_parts.append(
                f'<p style="margin:12px 0 0;color:#6b7280;font-size:14px;line-height:1.55;">'
                f'\U0001F4CE {n} {noun} attached.'
                f'</p>'
            )
            plain_parts.append(f"{n} {noun} attached.")
        for name in (skipped or []):
            html_parts.append(
                f'<p style="margin:4px 0 0;color:#6b7280;font-size:13px;line-height:1.5;">'
                f'“{_html.escape(name)}” was too large to attach — open the app to download it.'
                f'</p>'
            )
            plain_parts.append(
                f'"{name}" was too large to attach — open the app to download it.'
            )
        if report_url:
            safe_url = _html.escape(report_url, quote=True)
            html_parts.append(
                f'<p style="margin:12px 0 0;line-height:1.55;">'
                f'<a href="{safe_url}" style="color:{_COLOR_ACCENT};text-decoration:none;font-weight:600;">'
                f'View the project report →</a>'
                f'</p>'
            )
            plain_parts.append(f"Report: {report_url}")
        extra_html = "".join(html_parts) or None
        plain_suffix = ("\n" + "\n".join(plain_parts) + "\n") if plain_parts else ""
        return extra_html, plain_suffix

    # ------------------------------------------------------------------
    # Notification factories (project / agent / chatroom-aware)
    # ------------------------------------------------------------------

    @classmethod
    def assistant_message(
        cls,
        *,
        to_email: str,
        username: str,
        assistant_name: str,
        project: Project,
        chatroom_name: str,
        content: str,
        app_base_url: str,
        attachments: Optional[list[EmailAttachment]] = None,
        attachments_skipped: Optional[list[str]] = None,
        report_url: Optional[str] = None,
    ) -> ClawMeetsEmailMessage:
        """Assistant (coordinator) posted to the user-communication room."""
        display_name = cls.humanize_agent_name(assistant_name, username)
        project_label = project.display_name or project.name
        preview = cls.first_sentence(content, max_len=110)
        subject = (
            f"{display_name}: {preview}"
            if preview
            else f"New message from {display_name} in “{project_label}”"
        )
        cta_url = cls.chatroom_url(app_base_url, project.id, chatroom_name)
        intro_html = (
            f"Hi {_html.escape(username)} \U0001F44B &mdash; your assistant "
            f"<strong>{_html.escape(display_name)}</strong> left a note in project "
            f"<strong>{_html.escape(project_label)}</strong>."
        )
        extra_html, plain_suffix = cls._assets_block(
            report_url, attachments, attachments_skipped
        )
        html_body = cls.render_notification_html(
            preheader=preview or f"New update in {project_label}",
            headline=f"New message from {display_name}",
            intro_html=intro_html,
            quote_content_md=content,
            extra_html=extra_html,
            cta_url=cta_url,
            cta_label="Open chatroom",
        )
        plain = (
            f"Hi {username},\n\n"
            f"Your assistant \"{display_name}\" left a note in project \"{project_label}\".\n\n"
            f"{cls.strip_markdown(content) or '(no content)'}\n"
            f"{plain_suffix}\n"
            f"Open: {cta_url}\n\n"
            f"— ClawMeets\n"
        )
        return cls(
            to_email=to_email,
            subject=subject,
            body=plain,
            html_body=html_body,
            attachments=list(attachments or []),
            log_label="Notification email",
        )

    @classmethod
    def dm_response(
        cls,
        *,
        to_email: str,
        username: str,
        agent_name: str,
        project: Project,
        chatroom_name: str,
        content: str,
        app_base_url: str,
        attachments: Optional[list[EmailAttachment]] = None,
        attachments_skipped: Optional[list[str]] = None,
        report_url: Optional[str] = None,
    ) -> ClawMeetsEmailMessage:
        """DM chatroom batch completed — the agent replied to the user's DM."""
        display_name = cls.humanize_agent_name(agent_name, username)
        preview = cls.first_sentence(content, max_len=110)
        subject = (
            f"{display_name}: {preview}"
            if preview
            else f"{display_name} replied to your DM"
        )
        cta_url = cls.chatroom_url(app_base_url, project.id, chatroom_name)
        intro_html = (
            f"Hi {_html.escape(username)} \U0001F44B &mdash; "
            f"<strong>{_html.escape(display_name)}</strong> replied to your direct message."
        )
        extra_html, plain_suffix = cls._assets_block(
            report_url, attachments, attachments_skipped
        )
        html_body = cls.render_notification_html(
            preheader=preview or f"{display_name} replied to your DM",
            headline=f"{display_name} replied",
            intro_html=intro_html,
            quote_content_md=content,
            extra_html=extra_html,
            cta_url=cta_url,
            cta_label="View conversation",
        )
        plain = (
            f"Hi {username},\n\n"
            f"{display_name} replied to your direct message.\n\n"
            f"{cls.strip_markdown(content) or '(no content)'}\n"
            f"{plain_suffix}\n"
            f"Open: {cta_url}\n\n"
            f"— ClawMeets\n"
        )
        return cls(
            to_email=to_email,
            subject=subject,
            body=plain,
            html_body=html_body,
            attachments=list(attachments or []),
            log_label="Notification email",
        )

    @classmethod
    def project_completed(
        cls,
        *,
        to_email: str,
        username: str,
        project: Project,
        app_base_url: str,
        attachments: Optional[list[EmailAttachment]] = None,
        attachments_skipped: Optional[list[str]] = None,
        report_url: Optional[str] = None,
    ) -> ClawMeetsEmailMessage:
        """Project marked as completed."""
        project_label = project.display_name or project.name
        subject = f"“{project_label}” is complete"
        cta_url = cls.project_url(app_base_url, project.id)
        intro_html = (
            f"Hi {_html.escape(username)} \U0001F44B &mdash; your project "
            f"<strong>{_html.escape(project_label)}</strong> has been marked complete."
        )
        extra_html, plain_suffix = cls._assets_block(
            report_url, attachments, attachments_skipped
        )
        html_body = cls.render_notification_html(
            preheader=f"{project_label} — all deliverables are ready",
            headline=f"{project_label} is complete",
            intro_html=intro_html,
            secondary_text=(
                "All deliverables are available in the chatrooms. You can review "
                "the final state and any artifacts from the project page."
            ),
            extra_html=extra_html,
            cta_url=cta_url,
            cta_label="View project",
        )
        plain = (
            f"Hi {username},\n\n"
            f"Your project \"{project_label}\" has been marked complete.\n\n"
            f"All deliverables are available in the chatrooms. Open the project to review.\n"
            f"{plain_suffix}\n"
            f"Open: {cta_url}\n\n"
            f"— ClawMeets\n"
        )
        return cls(
            to_email=to_email,
            subject=subject,
            body=plain,
            html_body=html_body,
            attachments=list(attachments or []),
            log_label="Notification email",
        )

    # ------------------------------------------------------------------
    # Account-lifecycle factories
    # ------------------------------------------------------------------

    @classmethod
    def verification(
        cls,
        *,
        to_email: str,
        username: str,
        verification_token: str,
    ) -> ClawMeetsEmailMessage:
        """Email-address verification link."""
        verification_url = (
            f"{VERIFICATION_BASE_URL}/app/auth/verify-email?token={verification_token}"
        )
        return cls(
            to_email=to_email,
            subject="Verify your ClawMeets account",
            body=(
                f"Hello {username},\n\n"
                f"Click the link below to verify your email:\n\n"
                f"{verification_url}\n\n"
                f"This link will expire when used.\n"
            ),
            log_label="Verification email",
        )

    @classmethod
    def waitlist(cls, *, to_email: str) -> ClawMeetsEmailMessage:
        """Waitlist confirmation (BCC'd to chengtao@clawmeets.ai)."""
        return cls(
            to_email=to_email,
            subject="You're on the ClawMeets waitlist",
            body=(
                "Thank you for your interest in ClawMeets!\n\n"
                "You're now on our waitlist. We'll send you an invitation code "
                "as soon as possible.\n\n"
                "If you have a strong use case and would like to expedite access, "
                "please reply to this email or reach out to info@clawmeets.ai.\n\n"
                "— The ClawMeets Team\n"
            ),
            bcc=["chengtao@clawmeets.ai"],
            log_label="Waitlist email",
        )
