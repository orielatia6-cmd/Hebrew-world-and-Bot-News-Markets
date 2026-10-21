import { Router, type IRouter } from "express";
import { GetNewsSourcesHealthResponse } from "@workspace/api-zod";
import { getNewsSourceHealth } from "../lib/briefing/news";

const router: IRouter = Router();

router.get("/briefing/sources", async (_req, res): Promise<void> => {
  const sources = await getNewsSourceHealth();
  res.json(GetNewsSourcesHealthResponse.parse(sources));
});

export default router;
