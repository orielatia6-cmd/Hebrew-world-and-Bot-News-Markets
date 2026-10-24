import { test } from "node:test";
import assert from "node:assert/strict";
import { digestSlot, israelDigestHours, similarHeadline } from "./schedule";

test("24 hourly slots each Israel day, including summer and winter offsets", () => {
  for (const [day, offset] of [["2026-07-01", 3], ["2026-12-01", 2]] as const) {
    let count = 0;
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(`${day}T${String(hour).padStart(2,"0")}:00:00Z`);
      if (digestSlot(now, null)) { count++; assert.ok(israelDigestHours(now).includes((hour + offset) % 24)); }
    }
    assert.equal(count, 24);
  }
});
test("hourly digest schedule covers 24 Israel-time hours across daylight saving", () => {
  const summer = israelDigestHours(new Date("2026-07-01T00:00:00Z"));
  const winter = israelDigestHours(new Date("2026-12-01T00:00:00Z"));
  assert.equal(summer.length, 24);
  assert.equal(winter.length, 24);
  assert.equal(new Set(summer).size, 24);
  assert.equal(new Set(winter).size, 24);
});
test("late runs recover the current Israel-hour slot without replaying completed slots", () => {
  assert.equal(digestSlot(new Date("2026-07-01T04:01:00Z"), new Date("2026-07-01T04:00:00Z")), null);
  assert.ok(digestSlot(new Date("2026-07-01T04:14:00Z"), null));
  assert.equal(
    digestSlot(new Date("2026-07-01T04:50:00Z"), null)?.toISOString(),
    "2026-07-01T04:00:00.000Z",
    "a delayed run can still deliver this hour's digest",
  );
  assert.equal(
    digestSlot(new Date("2026-07-01T04:50:00Z"), new Date("2026-07-01T04:00:00Z")),
    null,
    "a completed hour is never delivered twice",
  );
  assert.equal(
    digestSlot(new Date("2026-07-01T22:16:00Z"), new Date("2026-07-01T21:00:00Z"))?.toISOString(),
    "2026-07-01T22:00:00.000Z",
    "overnight hours remain scheduled, with no backfill of earlier hours",
  );
});
test("headline duplicate detection preserves different numbers", () => {
  assert.ok(similarHeadline("Nvidia launches new AI chips - BBC", "NVIDIA launches new AI chips"));
  assert.equal(similarHeadline("Tesla profits rise 10 percent", "Tesla profits fall 20 percent"), false);
});
