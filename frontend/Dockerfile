FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

# Create a non-root user and switch to it for security
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000
CMD ["npm", "start"]
