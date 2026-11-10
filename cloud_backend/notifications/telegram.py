
import os
import logging
import urllib.request
import urllib.parse
import json

logger = logging.getLogger(__name__)


def send_telegram_alert(event):
    """
    Send a collision alert to the configured Telegram chat.
    """

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")

    if not bot_token or not chat_id:
        logger.warning("Telegram credentials are not configured.")
        return False

    message = (
        "🚨 SAFERIDE EMERGENCY ALERT 🚨\n\n"
        "A possible vehicle collision has been detected!\n\n"
        f"Event Type: {event.get('event_type')}\n"
        f"Latitude: {event.get('latitude')}\n"
        f"Longitude: {event.get('longitude')}\n"
        f"X: {event.get('x')}\n"
        f"Y: {event.get('y')}\n"
        f"Z: {event.get('z')}\n"
        f"Vibration: {event.get('vibration')}\n"
        f"Impact Delta: {event.get('delta')}\n"
    )

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"

    payload = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": message
    }).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=payload,
        method="POST"
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))

        if result.get("ok"):
            logger.info("Telegram collision alert sent successfully.")
            return True

        logger.error("Telegram API rejected the alert.")
        return False

    except Exception:
        logger.error("Failed to send Telegram collision alert.")
        return False
