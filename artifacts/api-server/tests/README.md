# Briefing regression checks

Run from the workspace root:

```sh
pnpm --filter @workspace/api-server test
```

Uses Node's built-in test runner and the existing esbuild dependency. Tests bundle
the actual implementation while substituting database, RSS, OpenAI and Telegram
I/O. No real messages are sent, no database is changed, and no paid API is called.
Coverage includes Telegram private-chat ownership, owner-only commands,
five-minute manual-refresh throttling, pause/resume, long-poll timeout selection,
feed URL deduplication and
already-analyzed stories, Hebrew analysis validation, importance boundaries,
delivery cadence, refresh cadence, and successful/failed delivery state.

The six-hour scheduler fixture tests interval arithmetic only: the current
Telegram commands do not offer 360 minutes or four fixed daily send times.

The current Telegram-only product intentionally has no website login flow.
One-time-code expiry/session tests from the original task scope are therefore
not applicable; removed dashboard routes and authentication are not restored.

These are isolated regression checks, not a live database/Telegram integration
test. The lightweight database double checks filtering and writes, but does not
validate PostgreSQL constraints, transactions, or network behavior.
