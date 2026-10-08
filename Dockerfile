FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html server.cjs game-rules.cjs ./
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["npm", "start"]
