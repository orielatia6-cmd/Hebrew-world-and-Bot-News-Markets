import { eq } from "drizzle-orm";
import {
  briefingSettingsTable,
  db,
  type BriefingSettings as DbBriefingSettings,
} from "@workspace/db";

export async function ensureBriefingSettings(): Promise<DbBriefingSettings> {
  await db
    .insert(briefingSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing();

  const [settings] = await db
    .select()
    .from(briefingSettingsTable)
    .where(eq(briefingSettingsTable.id, 1))
    .limit(1);

  if (!settings) {
    throw new Error("Briefing settings could not be initialized.");
  }

  return settings;
}
