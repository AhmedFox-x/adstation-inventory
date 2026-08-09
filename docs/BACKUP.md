# Backup & Restore Guide

## Overview
The AD Station Inventory System includes automated daily backups of:
- **Database**: PostgreSQL dump (compressed with gzip)
- **Images**: All product images from the uploads volume

Backups are stored in AWS S3 with 30-day retention.

## Setup

### 1. Create S3 Bucket
```bash
aws s3 mb s3://adstation-inventory-backups --region us-east-1
```

### 2. Create IAM User
Create an IAM user with the following policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::adstation-inventory-backups",
        "arn:aws:s3:::adstation-inventory-backups/*"
      ]
    }
  ]
}
```

### 3. Configure GitHub Secrets
Add these secrets to your GitHub repository:
- `DATABASE_URL` - PostgreSQL connection string
- `AWS_ACCESS_KEY_ID` - IAM access key
- `AWS_SECRET_ACCESS_KEY` - IAM secret key
- `AWS_REGION` - S3 region (default: us-east-1)
- `BACKUP_S3_BUCKET` - S3 bucket name
- `BACKUP_S3_PREFIX` - S3 key prefix (default: inventory-backups)

### 4. Enable GitHub Actions
The backup runs automatically daily at 2:00 AM UTC (4:00 AM Cairo time).

To trigger manually:
```bash
gh workflow run daily-backup.yml
```

## Manual Backup

```bash
# Set environment variables
export DATABASE_URL="postgresql://..."
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export BACKUP_S3_BUCKET="adstation-inventory-backups"

# Run backup
npm run backup
```

## Restore

### List Available Backups
```bash
npm run restore
```

### Restore Specific Date
```bash
npm run restore -- 2026-07-23
```

This will:
1. Download database dump from S3
2. Drop and recreate the database
3. Restore from the dump
4. Download and extract images
5. Sync Prisma schema

## Backup Structure in S3
```
adstation-inventory-backups/
├── 2026-07-23/
│   ├── database-2026-07-23T02-00-00-000Z.sql.gz
│   └── images-2026-07-23T02-00-00-000Z.tar.gz
├── 2026-07-22/
│   ├── database-2026-07-22T02-00-00-000Z.sql.gz
│   └── images-2026-07-22T02-00-00-000Z.tar.gz
└── ...
```

## Retention Policy
- Backups older than 30 days are automatically deleted
- Configure via `RETENTION_DAYS` environment variable

## Troubleshooting

### Backup Fails
1. Check GitHub Actions logs
2. Verify IAM permissions
3. Test database connection: `psql $DATABASE_URL -c "SELECT 1"`
4. Check S3 bucket exists and is accessible

### Restore Fails
1. Ensure database is empty or willing to be overwritten
2. Check disk space for image extraction
3. Verify Prisma schema matches backup

## Emergency Contacts
- Database issues: Check Railway logs
- S3 issues: Check AWS Console
- Backup script issues: Check GitHub Actions
