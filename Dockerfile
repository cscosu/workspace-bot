FROM node:20-alpine as builder

RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./

RUN pnpm install

COPY index.ts .

RUN pnpm build

FROM node:20-alpine as runner

WORKDIR /app
COPY --from=builder /app/out/index.js index.js

CMD ["node", "index.js"]
