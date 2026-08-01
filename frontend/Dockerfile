# Dev server rather than a static build, so the stack is editable: this compose file exists
# to give a developer a working system in one command, not to produce a production artefact.
# A production image would be a two-stage `npm run build` into nginx.
#
# NOT VERIFIED: never built — no docker daemon was available where this was written.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# --host binds 0.0.0.0; Vite listens on localhost by default, which is unreachable from
# outside the container.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
