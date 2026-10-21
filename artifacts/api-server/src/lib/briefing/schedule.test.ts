import { test } from "node:test";
import assert from "node:assert/strict";
import { digestSlot, israelDigestHours, similarHeadline } from "./schedule";

test("four slots each Israel day, including summer and winter offsets", () => {
  for (const [day, offset] of [["2026-07-01", 3], ["2026-12-01", 2]] as const) {
    let count = 0;
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(`${day}T${String(hour).padStart(2,"0")}:00:00Z`);
      if (digestSlot(now, null)) { count++; assert.ok(israelDigestHours(now).includes((hour + offset) % 24)); }
    }
    assert.equal(count, 4);
  }
});
test("four fixed UTC workflow triggers map to Israel hours in both DST seasons", () => {
  assert.deepEqual(israelDigestHours(new Date("2026-07-01T00:00:00Z")), [8, 12, 16, 20]);
  assert.deepEqual(israelDigestHours(new Date("2026-12-01T00:00:00Z")), [7, 11, 15, 19]);
});
test("no replay of completed slots, bounded recovery, no overnight catchup", () => {
  assert.equal(digestSlot(new Date("2026-07-01T04:01:00Z"), new Date("2026-07-01T04:00:00Z")), null);
  assert.ok(digestSlot(new Date("2026-07-01T04:14:00Z"), null));
  assert.equal(digestSlot(new Date("2026-07-01T04:15:00Z"), null), null);
  assert.equal(digestSlot(new Date("2026-07-01T22:00:00Z"), null), null);
});
test("headline duplicate detection preserves different numbers", () => {
  assert.ok(similarHeadline("Nvidia launches new AI chips - BBC", "NVIDIA launches new AI chips"));
  assert.equal(similarHeadline("Tesla profits rise 10 percent", "Tesla profits fall 20 percent"), false);
});
