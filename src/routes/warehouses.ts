import { Router } from "express";
const router = Router();

router.get("/warehouses", async (_req, res) => {
  res.json({ message: "Warehouses feature coming soon" });
});

export default router;
