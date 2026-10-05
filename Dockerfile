FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    DEMO_MODE=true \
    STORAGE=csv \
    TZ=Asia/Hong_Kong \
    PORT=3000 \
    DATA_DIR=/app/persist/data \
    UPLOAD_DIR=/app/persist/uploads \
    STAGING_DIR=/app/persist/staging \
    MAIL_TRANSPORT=log

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/api/health || exit 1

CMD ["sh", "-c", "node scripts/bootstrap-demo-admin.js && node server.js"]
