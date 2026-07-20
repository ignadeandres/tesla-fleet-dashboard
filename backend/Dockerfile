FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY backend ./backend
WORKDIR /app/backend
RUN npm install --omit=dev
EXPOSE 4000
CMD ["node", "src/index.js"]
