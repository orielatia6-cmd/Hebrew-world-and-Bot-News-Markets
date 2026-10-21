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
    // Local fixture only: no workspace secret is modified or used in requests.
    process.env.TELEGRAM_BOT_TOKEN = `fixture-${process.pid}`;
    const calls = [], sent = [];
    globalThis.fetch = async (url, options) => {
      const method = new URL(url).pathname.split("/").at(-1);
      calls.push(method);
      const body = JSON.parse(options.body);
      let result = true;
      if (method === "getMe") result = { username: "Oriel_news_bot" };
      if (method === "getWebhookInfo") result = { url: "" };
      if (method === "getUpdates") result = ["/start", "/test", "/refresh", "/stoptest"].map((text, i) => ({
        update_id: i + 1, message: { text, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
      }));
      if (method === "sendMessage") sent.push(body.text);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    };
    await runDevTest();
    assert.equal(sent.length, 4);
    assert.ok(sent[0].includes("אין צורך בקוד"));
    assert.equal(sent[2], testReply("/refresh"));
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
    await assert.rejects(runDevTest(), /polling conflict/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    await rm(directory, { recursive: true, force: true });
  }
});
