FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY worker ./worker
WORKDIR /app/worker
RUN npm install --omit=dev
CMD ["node", "src/poller.js"]
