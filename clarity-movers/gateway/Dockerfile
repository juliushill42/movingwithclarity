FROM node:20-alpine
WORKDIR /app
COPY gateway/package.json ./
RUN npm install --omit=dev
COPY gateway/. .
COPY frontend /frontend
EXPOSE 4000
CMD ["node", "index.js"]
