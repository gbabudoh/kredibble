"""Outgoing email over SMTP (your own mail server). Without SMTP_HOST the message is logged instead."""
import logging
import smtplib
import ssl
from email.message import EmailMessage

from app.config import settings

logger = logging.getLogger("kredibble.mail")


def send_email(to: str, subject: str, body: str) -> None:
    """Sends a plain-text email. Runs as a background task, so failures are logged, not raised."""
    message = EmailMessage()
    message["From"] = settings.MAIL_FROM
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    if not settings.SMTP_HOST:
        logger.warning("SMTP_HOST is not set; email not sent. To: %s | Subject: %s\n%s", to, subject, body)
        return

    try:
        context = ssl.create_default_context()
        if settings.SMTP_SSL:
            server = smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, context=context, timeout=20)
        else:
            server = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=20)
        with server:
            if settings.SMTP_STARTTLS and not settings.SMTP_SSL:
                server.starttls(context=context)
            if settings.SMTP_USERNAME:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            server.send_message(message)
    except (OSError, smtplib.SMTPException):
        logger.exception("Could not send email to %s (%s)", to, subject)
