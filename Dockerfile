FROM node:24-bookworm-slim AS build
WORKDIR /source
RUN npm install --global pnpm@11.1.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
ENV HUSKY=0
RUN pnpm install --frozen-lockfile
COPY . .
ARG PRIVATE_COMMIT
RUN node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("private/manifest.json"));if(!/^[a-f0-9]{40}$/.test(process.argv[1]))throw Error("Commit required");m.commit=process.argv[1];fs.writeFileSync("private/manifest.json",JSON.stringify(m));' "$PRIVATE_COMMIT"
RUN node --import tsx tools/scripts/setupEnvFiles.ts && pnpm exec vite build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--dns-result-order=ipv4first
COPY private/translation/requirements.txt /tmp/ocr-requirements.txt
RUN apt-get update && apt-get install --no-install-recommends -y python3 python3-venv libglib2.0-0 libgl1 libgomp1 fonts-dejavu-core ca-certificates \
    && python3 -m venv /opt/ocr \
    && /opt/ocr/bin/pip install --no-cache-dir torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cpu \
    && /opt/ocr/bin/pip install --no-cache-dir -r /tmp/ocr-requirements.txt \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY private/translation/download_models.py /tmp/download_models.py
RUN /opt/ocr/bin/python /tmp/download_models.py
COPY --from=build /source/build ./build
COPY --from=build /source/private ./private
COPY LICENSE ./
USER 0:0
EXPOSE 18081
HEALTHCHECK --interval=10s --timeout=6s --start-period=20s --retries=6 CMD ["node", "-e", "fetch('http://192.168.175.60:18081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "private/server/gateway.mjs"]
