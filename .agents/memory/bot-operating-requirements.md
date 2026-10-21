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

For development-only Telegram diagnostics, keep the test isolated and bounded rather than enabling the full production bot with its news and AI work.

**Why:** The user explicitly requested a temporary test without publishing or OpenAI usage and confirmed that the isolated welcome and test replies arrived without a login code.

**How to apply:** Obtain authorization for a temporary session, retain the paid-hosting approval boundary, and stop the listener after verification. Successful temporary delivery does not establish production readiness or authorize continuous development polling.
