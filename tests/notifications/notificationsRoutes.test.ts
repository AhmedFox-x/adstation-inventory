import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import notificationsRouter from '../../src/routes/notifications';
import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';

const JWT_SECRET = 'test-notif-secret';

function makeToken(userId: string): string {
  return jwt.sign({ userId, email: `${userId}@x.com`, role: 'manager' }, JWT_SECRET);
}

describe('Notifications Routes (P4.2)', () => {
  let server: http.Server;
  let base: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const app = express();
    app.use(express.json());
    app.use('/api/inventory', notificationsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory`;
  });

  beforeEach(async () => {
    await cleanDb();
    const a = await testPrisma.user.create({
      data: { email: `a-${Date.now()}@x.com`, password: 'hash', firstName: 'A', lastName: 'U', role: 'manager' },
    });
    const b = await testPrisma.user.create({
      data: { email: `b-${Date.now()}@x.com`, password: 'hash', firstName: 'B', lastName: 'U', role: 'manager' },
    });
    userA = a.id;
    userB = b.id;
  });

  afterAll(async () => {
    await cleanDb();
    await new Promise<void>((resolve, reject) => server.close((e: any) => (e ? reject(e) : resolve())));
  });

  async function api(method: string, path: string, token: string, body?: any) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  function seedNotification(userId: string, overrides: any = {}) {
    return testPrisma.notification.create({
      data: { userId, type: 't', title: 'x', message: 'm', ...overrides },
    });
  }

  test('GET /notifications/unread-count returns correct count (isRead + deletedAt filter)', async () => {
    const unread1 = await seedNotification(userA);
    await seedNotification(userA, { isRead: true, readAt: new Date() });
    await seedNotification(userA, { deletedAt: new Date() });
    await seedNotification(userB);

    const r1 = await api('GET', '/notifications/unread-count', makeToken(userA));
    expect(r1.status).toBe(200);
    expect(r1.json).toEqual({ count: 1 });

    await testPrisma.notification.update({
      where: { id: unread1.id },
      data: { isRead: true, readAt: new Date() },
    });

    const r2 = await api('GET', '/notifications/unread-count', makeToken(userA));
    expect(r2.json).toEqual({ count: 0 });
  });

  test('read-all zeroes unread count and affects only owner', async () => {
    await seedNotification(userA);
    await seedNotification(userA);
    await seedNotification(userB);

    const r = await api('PUT', '/notifications/read-all', makeToken(userA));
    expect(r.status).toBe(200);
    expect(r.json.updated).toBe(2);

    const unread = await api('GET', '/notifications/unread-count', makeToken(userA));
    expect(unread.json).toEqual({ count: 0 });

    const bUnread = await api('GET', '/notifications/unread-count', makeToken(userB));
    expect(bUnread.json).toEqual({ count: 1 });
  });

  test('read reduces unread count', async () => {
    const n = await seedNotification(userA);

    const before = await api('GET', '/notifications/unread-count', makeToken(userA));
    expect(before.json).toEqual({ count: 1 });

    const r = await api('PUT', `/notifications/${n.id}/read`, makeToken(userA));
    expect(r.status).toBe(200);
    expect(r.json.notification.isRead).toBe(true);
    expect(r.json.notification.readAt).not.toBeNull();

    const after = await api('GET', '/notifications/unread-count', makeToken(userA));
    expect(after.json).toEqual({ count: 0 });
  });

  test('soft delete hides notification from list, total, and unread count', async () => {
    const n = await seedNotification(userA);

    const before = await api('GET', '/notifications?page=1&limit=10', makeToken(userA));
    expect(before.status).toBe(200);
    expect(before.json.total).toBe(1);
    expect(before.json.unread).toBe(1);
    expect(before.json.notifications.map((x: any) => x.id)).toContain(n.id);

    const del = await api('DELETE', `/notifications/${n.id}`, makeToken(userA));
    expect(del.status).toBe(200);
    expect(del.json.notification.deletedAt).not.toBeNull();

    const row = await testPrisma.notification.findUnique({ where: { id: n.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();

    const after = await api('GET', '/notifications?page=1&limit=10', makeToken(userA));
    expect(after.json.total).toBe(0);
    expect(after.json.unread).toBe(0);
    expect(after.json.notifications).toHaveLength(0);

    const unread = await api('GET', '/notifications/unread-count', makeToken(userA));
    expect(unread.json).toEqual({ count: 0 });
  });

  test('A cannot read notification of B (404)', async () => {
    const n = await seedNotification(userB);
    const r = await api('PUT', `/notifications/${n.id}/read`, makeToken(userA));
    expect(r.status).toBe(404);

    const fresh = await testPrisma.notification.findUnique({ where: { id: n.id } });
    expect(fresh!.isRead).toBe(false);
  });

  test('A cannot soft-delete notification of B (404)', async () => {
    const n = await seedNotification(userB);
    const r = await api('DELETE', `/notifications/${n.id}`, makeToken(userA));
    expect(r.status).toBe(404);

    const fresh = await testPrisma.notification.findUnique({ where: { id: n.id } });
    expect(fresh!.deletedAt).toBeNull();
  });

  test('list does not expose B notifications to A (isolation)', async () => {
    await seedNotification(userA);
    await seedNotification(userB);

    const r = await api('GET', '/notifications?page=1&limit=10', makeToken(userA));
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(1);
    expect(r.json.notifications).toHaveLength(1);
    expect(r.json.notifications[0].userId).toBe(userA);
  });

  test('pagination returns totals and totalPages consistently', async () => {
    for (let i = 0; i < 7; i++) {
      await seedNotification(userA);
    }

    const page1 = await api('GET', '/notifications?page=1&limit=3', makeToken(userA));
    expect(page1.status).toBe(200);
    expect(page1.json.total).toBe(7);
    expect(page1.json.unread).toBe(7);
    expect(page1.json.notifications).toHaveLength(3);
    expect(page1.json.page).toBe(1);
    expect(page1.json.pages).toBe(3);
    expect(page1.json.pagination).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });

    const page2 = await api('GET', '/notifications?page=2&limit=3', makeToken(userA));
    expect(page2.json.pagination).toEqual({ page: 2, limit: 3, total: 7, totalPages: 3 });
    expect(page2.json.notifications).toHaveLength(3);

    const page3 = await api('GET', '/notifications?page=3&limit=3', makeToken(userA));
    expect(page3.json.pagination).toEqual({ page: 3, limit: 3, total: 7, totalPages: 3 });
    expect(page3.json.notifications).toHaveLength(1);

    const unreadOnly = await api('GET', '/notifications?page=1&limit=3&unreadOnly=true', makeToken(userA));
    expect(unreadOnly.json.total).toBe(7);
    expect(unreadOnly.json.unread).toBe(7);

    await testPrisma.notification.updateMany({
      where: { userId: userA },
      data: { isRead: true, readAt: new Date() },
    });
    const unreadOnlyAfter = await api('GET', '/notifications?page=1&limit=3&unreadOnly=true', makeToken(userA));
    expect(unreadOnlyAfter.json.total).toBe(0);
    expect(unreadOnlyAfter.json.notifications).toHaveLength(0);
    expect(unreadOnlyAfter.json.unread).toBe(0);
  });

  test('pagination totals stay correct with deleted + unreadOnly + mixed users', async () => {
    // A: 6 إشعارات — 2 مقروء، 1 محذوف (soft)، 3 unread
    for (let i = 0; i < 3; i++) await seedNotification(userA);
    await seedNotification(userA, { isRead: true, readAt: new Date() });
    await seedNotification(userA, { isRead: true, readAt: new Date() });
    await seedNotification(userA, { deletedAt: new Date() });
    // B: 4 إشعارات unread — لا يجب أن تدخل في حسابات A
    for (let i = 0; i < 4; i++) await seedNotification(userB);

    // الشامل لـ A: 5 فقط (6 ناقص المحذوف)
    const all = await api('GET', '/notifications?page=1&limit=2', makeToken(userA));
    expect(all.json.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(all.json.unread).toBe(3);

    // unreadOnly لـ A: 3 فقط، المحذوف لا يدخل
    const unread = await api('GET', '/notifications?page=1&limit=2&unreadOnly=true', makeToken(userA));
    expect(unread.json.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(unread.json.unread).toBe(3);
    expect(unread.json.notifications).toHaveLength(2);

    // B غير متأثر
    const b = await api('GET', '/notifications?page=1&limit=10&unreadOnly=true', makeToken(userB));
    expect(b.json.pagination).toEqual({ page: 1, limit: 10, total: 4, totalPages: 1 });
    expect(b.json.unread).toBe(4);
  });
});
