import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");

// Bundle the real implementation with isolated I/O boundaries. No credentials,
// database connections, network calls, or production startup are used by tests.
export async function load(entry, mocks, exposed = {}) {
  const result = await build({
    entryPoints: [resolve(root, "src", entry)],
    bundle: true, write: false, platform: "node", format: "cjs",
    packages: "external",
    plugins: [{
      name: "isolated-io",
      setup(plugin) {
        plugin.onResolve({ filter: /.*/ }, (args) => {
          const key = Object.keys(mocks).find((key) => args.path === key || args.path.endsWith(`/${key}`));
          if (key) return { path: key, namespace: "mock" };
        });
        plugin.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: Object.keys(mocks[args.path]).map(
            (key) => key === "default"
              ? `export default __mocks[${JSON.stringify(args.path)}].default;`
              : `export const ${key} = __mocks[${JSON.stringify(args.path)}][${JSON.stringify(key)}];`,
          ).join("\n"),
          loader: "js",
        }));
        plugin.onLoad({ filter: /\.ts$/ }, async (args) => {
          const extra = exposed[args.path.split("/").at(-1)];
          if (!extra) return;
          return {
            contents: `${await readFile(args.path, "utf8")}\nexport { ${extra.join(", ")} };`,
            loader: "ts",
          };
        });
      },
    }],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", "__mocks", result.outputFiles[0].text)(
    require, module, module.exports, mocks,
  );
  return module.exports;
}

export function fixture() {
  const settings = {
    id: 1, enabled: true, telegramChatId: "101", lastTelegramUpdateId: 0,
    deliveryIntervalMinutes: 60, minImportance: 4,
    lastSentAt: null, lastProcessedDigestSlotAt: null,
    lastCheckedAt: new Date(), lastError: null,
  };
  const stories = [];
  const sent = [];
  const warnings = [];
  const table = (name) => new Proxy({ name }, { get: (target, key) => key === "name" ? target.name : key });
  const settingsTable = table("settings");
  const feedHealthTable = table("feedHealth");
  const storiesTable = table("stories");
  const feedHealth = [];
  const rows = (t) => t === settingsTable ? [settings] : t === feedHealthTable ? feedHealth : stories;
  const compare = (op) => (key, value) => (row) => op(row[key], value);
  const orm = {
    eq: compare((a, b) => a === b),
    gte: compare((a, b) => a >= b),
    gt: compare((a, b) => a > b),
    isNull: (key) => (row) => row[key] == null,
    inArray: compare((a, b) => b.includes(a)),
    and: (...filters) => (row) => filters.every((f) => f(row)),
    or: (...filters) => (row) => filters.some((f) => f(row)),
    desc: (key) => key,
    sql: () => null,
  };
  const db = {
    select() {
      let selected = [];
      const query = {
        from(t) { selected = rows(t); return query; },
        where(predicate) { selected = selected.filter(predicate ?? (() => true)); return query; },
        orderBy(...keys) { selected = [...selected].sort((a, b) => {
          for (const key of keys) { const delta = b[key] - a[key]; if (delta) return delta; }
          return 0;
        }); return query; },
        limit(n) { selected = selected.slice(0, n); return query; },
        then(resolve) { return Promise.resolve(selected.map((r) => ({ ...r }))).then(resolve); },
      };
      return query;
    },
    update(t) {
      return { set(patch) { return { where(predicate) {
        const changed = rows(t).filter(predicate);
        changed.forEach((row) => Object.assign(row, patch));
        return { returning: async () => changed.map((r) => ({ ...r })) };
      } }; } };
    },
    insert(t) {
      return { values(values) {
        const inserted = [];
        const list = Array.isArray(values) ? values : [values];
        return {
          onConflictDoNothing() {
            for (const value of list) {
              if (rows(t).some((r) =>
                (r.sourceId === value.sourceId && r.revisionKey === value.revisionKey) ||
                (r.eventKey === value.eventKey && r.revisionKey === value.revisionKey)
              )) continue;
              const row = { id: stories.length + 1, deliveredAt: null, createdAt: new Date(), ...value };
              rows(t).push(row);
              inserted.push(row);
            }
            return { returning: async () => inserted };
          },
          onConflictDoUpdate({ target, set }) {
            for (const value of list) {
              const existing = rows(t).find((row) => row[target] === value[target]);
              if (existing) Object.assign(existing, set);
              else rows(t).push({ ...value });
            }
            return Promise.resolve();
          },
        };
      } };
    },
  };
  const mocks = {
    "@workspace/db": {
      db,
      briefingSettingsTable: settingsTable,
      briefingFeedHealthTable: feedHealthTable,
      briefingStoriesTable: storiesTable,
    },
    "drizzle-orm": orm,
    store: {
      ensureBriefingSettings: async () => ({ ...settings }),
    },
    logger: { logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) } },
  };
  return { settings, stories, feedHealth, sent, warnings, mocks };
}

export function story(id, importance = 4) {
  return {
    id, sourceId: `source-${id}`, revisionKey: `revision-${id}`,
    eventKey: `event-${id}`, originalTitle: `Original ${id}`,
    title: "כותרת", summary: "סיכום",
    whyItMatters: "חשיבות", marketImpact: "השפעה",
    url: `https://example.test/${id}`, category: "world",
    importance, tickers: [], deliveredAt: null, createdAt: new Date(), publishedAt: new Date(),
  };
}

