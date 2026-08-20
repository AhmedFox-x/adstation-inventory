import { Router } from "express";
const router = Router();

router.get("/transfers", async (_req, res) => {
  res.json({ message: "Transfers feature coming soon" });
});

export default router;
