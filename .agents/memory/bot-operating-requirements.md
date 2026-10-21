---
name: Bot operating requirements
description: User's operating goal and deployment approval boundary for the existing Telegram bot.
---

Preserve the existing project rather than rebuilding completed features. The user's latest plan is four Hebrew scheduled digests per day using GitHub Actions and Neon Free, accepting delayed news and no instant breaking alerts.

**Why:** The user explicitly changed the schedule to four daily summaries and accepted delayed delivery as a low-cost tradeoff.

**How to apply:** Preserve four daily Israel-time digests. GitHub Actions is a scheduled runner, not an always-on Telegram poller; explain command and alert delays. Do not restore the older eight-digest schedule unless asked.

Keep the existing hosting setup and ask before adding paid services or changing hosting. Explain the exact next step and additional cost before any proposed paid deployment change.

**Why:** The user explicitly requested cost disclosure before changes.

**How to apply:** Check current hosting, database, and AI usage pricing; do not quote only the hosting charge or assume available credits cover it.

For development-only Telegram diagnostics, keep the test isolated and bounded rather than enabling the full production bot with its news and AI work.

**Why:** The user explicitly requested a temporary test without publishing or OpenAI usage and confirmed that the isolated welcome and test replies arrived without a login code.

**How to apply:** Obtain authorization for a temporary session, retain the paid-hosting approval boundary, and stop the listener after verification. Successful temporary delivery does not establish production readiness or authorize continuous development polling.
