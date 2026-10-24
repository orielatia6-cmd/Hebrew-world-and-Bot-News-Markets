# Briefline Telegram News Bot

Briefline is a Telegram-only Hebrew news bot for important world events, Donald Trump and White House statements, broad markets, major technology stocks, AI, and semiconductors. It explains what happened, why it matters, and possible market effects with links to sources.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the Telegram polling and scheduled-delivery service
- `pnpm --filter @workspace/hebrew-market-briefing run dev` — run the static bot-start page; it has no dashboard or controls
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`
- The workspace also provides `DATABASE_URL` for PostgreSQL.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/hebrew-market-briefing` — static Hebrew Telegram launch and setup page only.
- `artifacts/api-server/src/lib/briefing` — RSS collection, Hebrew analysis, Telegram commands, and scheduler.
- `lib/db/src/schema/briefing.ts` — persisted preferences and analyzed story archive.
- `lib/api-spec/openapi.yaml` — source of truth for the health endpoint.

## Architecture decisions

- The first private Telegram chat to send `/start` claims the bot; later chats cannot connect to it.
- RSS feeds are checked every 15 minutes; stories at the configured importance threshold are grouped for delivery on the configured cadence.
- Story explanations use the user's server-side OpenAI key; it is never sent to the browser.

## Product

- Reads world, Trump, S&P 500, Nasdaq, Nvidia, Tesla, AI, and semiconductor news from public RSS feeds.
- Explains each story in Hebrew: what happened, why it matters, and a possible—not predictive—market impact.
- Delivers stories at importance 4/5 or higher by default, with schedule and threshold adjustable by Telegram commands.
- Telegram commands: `/status`, `/interval`, `/importance`, `/pause`, `/resume`, `/refresh`, `/test`, and `/help`.

## User preferences

- The product is the Telegram bot, not a website dashboard.
- All briefings, bot responses, and explanations should be in Hebrew.
- Send a digest every hour, 24 hours a day, using Asia/Jerusalem time.
- Breaking alerts (importance 5/5, published within two hours) bypass digest timing, including overnight; RSS polling remains every 15 minutes. No placeholder digest is sent when there are no important stories.
- Do not change hosting or add paid services without asking. Duplicate URL and similar Hebrew headline protection applies; delivered alerts are excluded from digests.

## Gotchas

- The API server must run continuously for polling and scheduled delivery. Publish using a Reserved VM deployment for unattended operation.
- `/start` in the bot links the first private chat directly; there is no website login step.
- After changing an API route, update `lib/api-spec/openapi.yaml` and rerun codegen.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
