FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install
RUN npx prisma generate

COPY . .
RUN npx tsc

EXPOSE 4001

CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/seed-import.js && node dist/index.js"]
