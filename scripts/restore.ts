/**
 * Restore script for AD Station Inventory System
 * 
 * Usage:
 *   npx ts-node scripts/restore.ts <backup-date>
 * 
 * Example:
 *   npx ts-node scripts/restore.ts 2026-07-23
 * 
 * This will:
 *   1. Download the database dump from S3
 *   2. Restore the database
 *   3. Download and extract images
 * 
 * Environment variables required:
 *   DATABASE_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *   AWS_REGION, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX, VOLUME_PATH
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// ─── Config ──────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL!;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID!;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = process.env.BACKUP_S3_BUCKET!;
const S3_PREFIX = process.env.BACKUP_S3_PREFIX || "inventory-backups";
const VOLUME_PATH = process.env.VOLUME_PATH || "/app/public/uploads/products";

function getS3Client() {
  return new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });
}

// ─── Download from S3 ────────────────────────────────────────────────────────
async function downloadFromS3(key: string, localPath: string): Promise<void> {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  const response = await client.send(command);

  if (!response.Body) throw new Error(`Empty response for ${key}`);

  const fileStream = createWriteStream(localPath);
  await pipeline(response.Body as Readable, fileStream);
  console.log(`  ✅ Downloaded: ${key}`);
}

// ─── List available backups ──────────────────────────────────────────────────
async function listBackups(): Promise<string[]> {
  const client = getS3Client();
  const command = new ListObjectsV2Command({
    Bucket: S3_BUCKET,
    Prefix: `${S3_PREFIX}/`,
  });

  const response = await client.send(command);
  const dates = new Set<string>();

  if (response.Contents) {
    for (const obj of response.Contents) {
      if (obj.Key) {
        const match = obj.Key.match(/(\d{4}-\d{2}-\d{2})/);
        if (match) dates.add(match[1]);
      }
    }
  }

  return Array.from(dates).sort().reverse();
}

// ─── Restore Database ────────────────────────────────────────────────────────
async function restoreDatabase(dumpFile: string): Promise<void> {
  console.log("📦 Restoring database...");

  const url = new URL(DATABASE_URL);
  const host = url.hostname;
  const port = url.port || "5432";
  const dbName = url.pathname.slice(1);
  const user = url.username;
  const password = url.password;

  const env = { ...process.env, PGPASSWORD: password };

  // Drop and recreate database
  try {
    execSync(`dropdb -h ${host} -p ${port} -U ${user} --if-exists ${dbName}`, { env, stdio: "pipe" });
    execSync(`createdb -h ${host} -p ${port} -U ${user} ${dbName}`, { env, stdio: "pipe" });
  } catch {
    console.log("  ⚠️  Could not drop/recreate DB, trying restore directly...");
  }

  // Restore from dump
  const cmd = `gunzip -c ${dumpFile} | psql -h ${host} -p ${port} -U ${user} -d ${dbName} -q`;
  execSync(cmd, { env, stdio: "pipe", timeout: 600000 });

  console.log("  ✅ Database restored");
}

// ─── Restore Images ──────────────────────────────────────────────────────────
async function restoreImages(tarFile: string): Promise<void> {
  console.log("🖼️  Restoring images...");

  if (!existsSync(VOLUME_PATH)) {
    mkdirSync(VOLUME_PATH, { recursive: true });
  }

  const cmd = `tar -xzf ${tarFile} -C ${VOLUME_PATH}`;
  execSync(cmd, { stdio: "pipe", timeout: 600000 });

  const fileCount = readdirSync(VOLUME_PATH).length;
  console.log(`  ✅ Restored ${fileCount} files to ${VOLUME_PATH}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const backupDate = process.argv[2];

  if (!backupDate) {
    // List available backups
    console.log("\n📋 Available backups:\n");
    const dates = await listBackups();
    if (dates.length === 0) {
      console.log("  No backups found");
      return;
    }
    dates.forEach((d) => console.log(`  ${d}`));
    console.log(`\nUsage: npx ts-node scripts/restore.ts <date>`);
    return;
  }

  console.log(`\n🔄 Restoring backup from ${backupDate}\n`);

  const tmpDir = "/tmp/restore";
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  try {
    // Find database dump
    const client = getS3Client();
    const listCmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${S3_PREFIX}/${backupDate}/`,
    });
    const listResp = await client.send(listCmd);

    if (!listResp.Contents || listResp.Contents.length === 0) {
      console.error(`❌ No backup found for ${backupDate}`);
      process.exit(1);
    }

    // Restore database
    const dbFile = listResp.Contents.find((c) => c.Key?.includes("database"));
    if (dbFile?.Key) {
      const localDb = join(tmpDir, basename(dbFile.Key));
      await downloadFromS3(dbFile.Key, localDb);
      await restoreDatabase(localDb);
    }

    // Restore images
    const imgFile = listResp.Contents.find((c) => c.Key?.includes("images"));
    if (imgFile?.Key) {
      const localImg = join(tmpDir, basename(imgFile.Key));
      await downloadFromS3(imgFile.Key, localImg);
      await restoreImages(localImg);
    }

    // Run prisma db push to sync schema
    console.log("\n🔧 Syncing schema...");
    execSync("npx prisma db push --skip-generate --accept-data-loss", {
      stdio: "pipe",
      timeout: 120000,
    });
    console.log("  ✅ Schema synced");

    console.log("\n✅ Restore complete! Restart the server.\n");
  } catch (err: any) {
    console.error(`\n❌ Restore failed: ${err.message}\n`);
    process.exit(1);
  }
}

main();
