import { Router, type IRouter } from "express";
import briefingRouter from "./briefing";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(briefingRouter);

export default router;
