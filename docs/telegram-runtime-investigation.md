# Obsolete Telegram reply investigation

## Findings — 2026-10-21

- The current source and compiled server bundle do not contain the old dashboard-login reply or login-code generator. An obsolete, unused login-code database column is still in the bundle; it is not a reply generator.
- Managed development workflow logs explicitly report that Telegram polling and scheduled delivery are disabled in development.
- Replit deployment metadata reports no active deployment for this project.
- Read-only Telegram `getMe` succeeded for the expected bot.
- Read-only `getWebhookInfo` reported no configured webhook, one pending update, and no webhook error. The pending update was not fetched or acknowledged.
- The initial development version previously could generate the old reply. There is no evidence establishing whether the user's message came from that version, another host, an isolated runtime, or was an older message noticed later.
- The owner could not establish the old message's timestamp. During a fresh check, the owner sent `/start` and reported no new reply within 30 seconds. This did not reproduce the obsolete reply; it is consistent with an inactive bot, but does not prove that no external instance exists.

## Boundaries

The local shell process list is not an authoritative inventory of managed workflows, isolated task workspaces, or external hosts. Telegram's webhook information does not identify other long-polling clients. These checks cannot prove that no external copy uses the same token.

During the initial read-only investigation, no credentials were printed, revoked, or rotated, and no webhook, ownership, hosting, delivery schedule, or queued Telegram updates were changed.

## Approved temporary live verification

The owner subsequently requested a temporary development test without publishing, purchasing hosting, changing secrets, collecting news, scheduling digests, or invoking OpenAI.

- An isolated, time-bounded runner was added. It imports neither the application database nor news/AI/scheduler modules.
- It checks bot identity and rejects production mode, active webhooks, and unavailable workspace-local polling locks. Telegram conflict errors stop the test; no webhook or token is changed.
- The runner ignores and acknowledges old queued commands and unsupported commands without executing them. This was explained before starting it.
- Telegram accepted fresh `/start` and `/test` replies. The owner explicitly confirmed receiving both without a login code.
- Telegram also accepted `/stoptest`. The runner logged `STOPPED`, exited with code 0, and its polling lock was absent afterward.
- Type checking, server compilation, and mocked tests covering command isolation, lock exclusion, production refusal, webhook refusal, and polling conflicts passed.

See `telegram-development-test.md` for the start/stop instructions. No permanent chat binding or saved delivery settings were written during this session.

## Remaining boundaries

1. The origin of the historical reply remains unconfirmed; the owner does not know its timestamp. Do not repeatedly request the old code or timestamp.
2. If another fresh obsolete reply appears, investigate other running copies with the owner's assistance; do not stop unrelated services without approval.
3. An intended published production runtime is not currently available. Publication requires the user's action and approval of any hosting costs.
4. Production startup, scheduled deliveries, and live OpenAI analysis were not verified by this temporary test. The workspace lock cannot exclude unknown hosts using separate filesystems.

The approved temporary Telegram-only delivery test is complete and stopped. This is not a claim that the unpublished production service is active or that the historical sender was conclusively identified.
