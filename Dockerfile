FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY prisma ./prisma/
RUN npx prisma generate
COPY . .
RUN npx tsc
EXPOSE 8080
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
