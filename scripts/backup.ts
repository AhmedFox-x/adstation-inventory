/**
 * Backup script for AD Station Inventory System
 * 
 * Usage:
 *   npx ts-node scripts/backup.ts
 * 
 * Environment variables required:
 *   DATABASE_URL     — PostgreSQL connection string
 *   AWS_ACCESS_KEY_ID     — S3 access key
 *   AWS_SECRET_ACCESS_KEY — S3 secret key
 *   AWS_REGION            — S3 region (default: us-east-1)
 *   BACKUP_S3_BUCKET      — S3 bucket name
 *   BACKUP_S3_PREFIX      — S3 key prefix (default: inventory-backups)
 *   VOLUME_PATH           — Path to uploads volume (default: /app/public/uploads/products)
 *   RETENTION_DAYS        — Days to keep backups (default: 30)
 */

import { execSync } from "child_process";
import { readdirSync, statSync, readFileSync, unlinkSync, existsSync, mkdirSync, createWriteStream } from "fs";
import { join, basename } from "path";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";

// ─── Config ──────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL!;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID!;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = process.env.BACKUP_S3_BUCKET!;
const S3_PREFIX = process.env.BACKUP_S3_PREFIX || "inventory-backups";
const VOLUME_PATH = process.env.VOLUME_PATH || "/app/public/uploads/products";
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "30", 10);

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

// ─── Validate ────────────────────────────────────────────────────────────────
function validate() {
  const missing = [];
  if (!DATABASE_URL) missing.push("DATABASE_URL");
  if (!AWS_ACCESS_KEY_ID) missing.push("AWS_ACCESS_KEY_ID");
  if (!AWS_SECRET_ACCESS_KEY) missing.push("AWS_SECRET_ACCESS_KEY");
  if (!S3_BUCKET) missing.push("BACKUP_S3_BUCKET");
  if (missing.length > 0) {
    console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ─── Database Backup ─────────────────────────────────────────────────────────
async function backupDatabase(): Promise<string> {
  console.log("📦 Backing up database...");
  const dumpFile = `/tmp/db-backup-${timestamp}.sql.gz`;

  try {
    // Parse connection string for pg_dump
    const url = new URL(DATABASE_URL);
    const host = url.hostname;
    const port = url.port || "5432";
    const dbName = url.pathname.slice(1);
    const user = url.username;
    const password = url.password;

    // Set PGPASSWORD for pg_dump
    const env = { ...process.env, PGPASSWORD: password };

    // Run pg_dump with compression
    const cmd = `pg_dump -h ${host} -p ${port} -U ${user} -d ${dbName} --no-owner --no-privileges --clean --if-exists | gzip > ${dumpFile}`;
    execSync(cmd, { env, stdio: "pipe", timeout: 300000 });

    const size = statSync(dumpFile).size;
    console.log(`  ✅ Database dump: ${(size / 1024 / 1024).toFixed(2)} MB`);
    return dumpFile;
  } catch (err: any) {
    console.error(`  ❌ Database backup failed: ${err.message}`);
    throw err;
  }
}

// ─── Image Backup ────────────────────────────────────────────────────────────
async function backupImages(): Promise<string | null> {
  console.log("🖼️  Backing up images...");

  if (!existsSync(VOLUME_PATH)) {
    console.log("  ⚠️  Volume path not found, skipping images");
    return null;
  }

  const tarFile = `/tmp/images-backup-${timestamp}.tar.gz`;

  try {
    // Create tar.gz of images directory
    const cmd = `tar -czf ${tarFile} -C ${VOLUME_PATH} .`;
    execSync(cmd, { stdio: "pipe", timeout: 600000 });

    const size = statSync(tarFile).size;
    const fileCount = readdirSync(VOLUME_PATH).length;
    console.log(`  ✅ Images: ${fileCount} files, ${(size / 1024 / 1024).toFixed(2)} MB`);
    return tarFile;
  } catch (err: any) {
    console.error(`  ❌ Image backup failed: ${err.message}`);
    return null;
  }
}

// ─── S3 Upload ───────────────────────────────────────────────────────────────
async function uploadToS3(filePath: string, s3Key: string): Promise<void> {
  const client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  const fileStream = readFileSync(filePath);
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: fileStream,
    ContentType: filePath.endsWith(".gz") ? "application/gzip" : "application/octet-stream",
  });

  await client.send(command);
  console.log(`  ✅ Uploaded: s3://${S3_BUCKET}/${s3Key}`);
}

// ─── Cleanup Old Backups ─────────────────────────────────────────────────────
async function cleanupOldBackups(): Promise<void> {
  console.log(`🧹 Cleaning up backups older than ${RETENTION_DAYS} days...`);

  const client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    const listCmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${S3_PREFIX}/`,
    });

    const response = await client.send(listCmd);
    if (!response.Contents || response.Contents.length === 0) {
      console.log("  No old backups to clean");
      return;
    }

    const toDelete = response.Contents.filter((obj) => {
      if (!obj.Key || !obj.LastModified) return false;
      // Extract date from key pattern: .../YYYY-MM-DD/...
      const dateMatch = obj.Key.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) return false;
      return dateMatch[1] < cutoffStr;
    }).map((obj) => ({ Key: obj.Key! }));

    if (toDelete.length === 0) {
      console.log("  No old backups to clean");
      return;
    }

    const deleteCmd = new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: toDelete },
    });

    await client.send(deleteCmd);
    console.log(`  ✅ Deleted ${toDelete.length} old backup(s)`);
  } catch (err: any) {
    console.error(`  ⚠️  Cleanup failed: ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔄 AD Station Backup — ${today}\n`);
  validate();

  const filesToCleanup: string[] = [];

  try {
    // 1. Database backup
    const dumpFile = await backupDatabase();
    filesToCleanup.push(dumpFile);
    await uploadToS3(dumpFile, `${S3_PREFIX}/${today}/database-${timestamp}.sql.gz`);

    // 2. Images backup
    const imageFile = await backupImages();
    if (imageFile) {
      filesToCleanup.push(imageFile);
      await uploadToS3(imageFile, `${S3_PREFIX}/${today}/images-${timestamp}.tar.gz`);
    }

    // 3. Cleanup old backups
    await cleanupOldBackups();

    console.log("\n✅ Backup complete!\n");
  } catch (err) {
    console.error("\n❌ Backup failed!\n");
    process.exit(1);
  } finally {
    // Clean up temp files
    for (const f of filesToCleanup) {
      try { unlinkSync(f); } catch {}
    }
  }
}

main();
