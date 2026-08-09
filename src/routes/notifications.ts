import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

// GET /notifications — إشعارات المستخدم الحالي
router.get("/notifications", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user?.userId;
    const { page = "1", limit = "50", unreadOnly } = req.query as Record<string, string>;

    const where: any = {
      userId,
      deletedAt: null,
    };
    if (unreadOnly === "true") where.isRead = false;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, isRead: false, deletedAt: null } }),
    ]);

    res.json({
      notifications,
      total,
      unread,
      page: Number(page),
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /notifications/:id/read — تحديد الإشعار كمقروء
router.put("/notifications/:id/read", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user?.userId;
    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification || (notification.userId && notification.userId !== userId)) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const updated = await prisma.notification.update({
      where: { id: req.params.id },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

// PUT /notifications/read-all — تحديد كل إشعارات المستخدم كمقروءة
router.put("/notifications/read-all", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user?.userId, isRead: false, deletedAt: null },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ updated: result.count });
  } catch (err) {
    next(err);
  }
});

export default router;
