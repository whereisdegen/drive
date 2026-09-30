# DRIVE: the game and its verification oracle, in one container on one port.
#
# The oracle imports the GAME's own physics modules to replay runs, so the image needs both
# directories — that shared code is the whole point and cannot be split apart.
FROM node:22-slim

WORKDIR /app

# deps first, so edits to the game or the oracle do not re-run npm install
COPY package.json package-lock.json ./
COPY oracle/package.json ./oracle/
RUN npm ci --omit=dev

COPY game/ ./game/
COPY oracle/ ./oracle/

# verified runs and their traces live here; mount a volume or the leaderboard resets on redeploy
RUN mkdir -p /app/oracle/data
VOLUME ["/app/oracle/data"]

ENV HOST=0.0.0.0 \
    PORT=8712 \
    NODE_ENV=production
EXPOSE 8712

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8712)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "oracle/server.mjs"]
