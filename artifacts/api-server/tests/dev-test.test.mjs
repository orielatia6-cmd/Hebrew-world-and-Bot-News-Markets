import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("temporary runner is isolated, restricted, and fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "briefline-runner-tests-"));
  const originalFetch = globalThis.fetch;
  const originalEnvironment = process.env.NODE_ENV;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalOwnerChatId = process.env.TELEGRAM_TEST_OWNER_CHAT_ID;
  try {
    await build({ entryPoints: ["src/lib/briefing/dev-test.ts"], outfile: join(directory, "runner.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    await build({ entryPoints: ["src/lib/briefing/poller-lock.ts"], outfile: join(directory, "lock.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { runDevTest, testReply } = await import(pathToFileURL(join(directory, "runner.mjs")));
    const { acquirePollerLock } = await import(pathToFileURL(join(directory, "lock.mjs")));
    const release = acquirePollerLock("non-secret-fixture", directory);
    assert.throws(() => acquirePollerLock("non-secret-fixture", directory), /lock unavailable/);
    release();
    acquirePollerLock("non-secret-fixture", directory)();
    process.env.NODE_ENV = "production";
    await assert.rejects(runDevTest(), /refused in production/);
    process.env.NODE_ENV = "development";
    // Local fixtures only: no workspace secret is modified or used in requests.
    process.env.TELEGRAM_BOT_TOKEN = `fixture-${process.pid}`;
    delete process.env.TELEGRAM_TEST_OWNER_CHAT_ID;
    let callsBeforeOwnerConfiguration = 0;
    globalThis.fetch = async () => {
      callsBeforeOwnerConfiguration++;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    await assert.rejects(runDevTest(), /TELEGRAM_TEST_OWNER_CHAT_ID/);
    assert.equal(callsBeforeOwnerConfiguration, 0, "runner must fail closed before contacting Telegram");

    process.env.TELEGRAM_TEST_OWNER_CHAT_ID = "42";
    const calls = [], sent = [];
    let updatesRequest = 0;
    globalThis.fetch = async (url, options) => {
      const method = new URL(url).pathname.split("/").at(-1);
      calls.push(method);
      const body = JSON.parse(options.body);
      let result = true;
      if (method === "getMe") result = { username: "Oriel_news_bot" };
      if (method === "getWebhookInfo") result = { url: "" };
      if (method === "getUpdates") {
        const date = Math.floor(Date.now() / 1000) + 10;
        if (updatesRequest === 0) {
          result = [{ update_id: 1, message: { text: "/start", date, chat: { id: 42, type: "private" } } }];
        } else if (updatesRequest === 1) {
          result = [];
        } else {
          result = [
            { update_id: 2, message: { text: "/start", date, chat: { id: 99, type: "private" } } },
            { update_id: 3, message: { text: "/start", date, chat: { id: 42, type: "group" } } },
            { update_id: 4, message: { text: "/start", date, chat: { id: 42, type: "private" } } },
            { update_id: 5, message: { text: "/test", date, chat: { id: 99, type: "private" } } },
            { update_id: 6, message: { text: "/status", date, chat: { id: 42, type: "private" } } },
            { update_id: 7, message: { text: "/test", date, chat: { id: 42, type: "private" } } },
            { update_id: 8, message: { text: "/refresh", date, chat: { id: 42, type: "private" } } },
            { update_id: 9, message: { text: "/stoptest", date, chat: { id: 42, type: "private" } } },
          ];
        }
        updatesRequest++;
      }
      if (method === "sendMessage") sent.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    };
    await runDevTest();
    assert.equal(sent.length, 6);
    assert.ok(sent.every(message => String(message.chatId) === "42"), "no other chat may receive a test reply");
    assert.match(sent[0].text, /בדיקת Telegram זמנית/);
    assert.ok(sent[1].text.includes("אין צורך בקוד"));
    assert.match(sent[1].text, /24 התדרוכים השעתיים/);
    assert.equal(sent[2].text, testReply("/status"));
    assert.equal(sent[3].text, testReply("/test"));
    assert.equal(sent[4].text, testReply("/refresh"));
    assert.equal(sent[5].text, testReply("/stoptest"));
    assert.equal(sent.filter(message => message.text.includes("בדיקת Telegram זמנית הופעלה")).length, 1);
    assert.equal(updatesRequest, 3, "queued updates must be drained before command handling starts");
    assert.ok(calls.every(method => ["getMe", "getWebhookInfo", "getUpdates", "sendMessage"].includes(method)));
    globalThis.fetch = async (url) => {
      const method = new URL(url).pathname.split("/").at(-1);
      const result = method === "getMe" ? { username: "Oriel_news_bot" } : { url: "https://example.invalid/webhook" };
      return new Response(JSON.stringify({ ok: true, result }));
    };
    await assert.rejects(runDevTest(), /active webhook/);
    globalThis.fetch = async (url) => {
      const method = new URL(url).pathname.split("/").at(-1);
      if (method === "getUpdates") return new Response(JSON.stringify({ ok: false, error_code: 409 }), { status: 409 });
      return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "Oriel_news_bot" } : { url: "" } }));
    };
    const sendsBeforeConflict = sent.length;
    await assert.rejects(runDevTest(), /polling conflict/);
    assert.equal(sent.length, sendsBeforeConflict, "a polling conflict must be detected before sending any test message");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalOwnerChatId === undefined) delete process.env.TELEGRAM_TEST_OWNER_CHAT_ID; else process.env.TELEGRAM_TEST_OWNER_CHAT_ID = originalOwnerChatId;
    await rm(directory, { recursive: true, force: true });
  }
});
