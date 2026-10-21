---
name: Bot operating requirements
description: User's operating goal and deployment approval boundary for the existing Telegram bot.
---

Preserve the existing project rather than rebuilding completed features. The user's latest requirement is eight Hebrew news digests per day during waking hours, plus immediate alerts for major breaking news, with duplicate stories avoided.

**Why:** The user explicitly replaced the earlier frequency request with eight daily digests and breaking alerts.

**How to apply:** Preserve eight scheduled digests, not four or an hourly interval. Explain polling latency rather than promising instantaneous event detection. Do not let older task plans overwrite the latest frequency.

Keep the existing hosting setup and ask before adding paid services or changing hosting. Explain the exact next step and additional cost before any proposed paid deployment change.

**Why:** The user explicitly requested cost disclosure before changes.

**How to apply:** Check current hosting, database, and AI usage pricing; do not quote only the hosting charge or assume available credits cover it.
