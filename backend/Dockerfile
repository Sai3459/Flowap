# Development image. Runs from source via ts-node rather than the compiled build, because
# that is how this project actually runs — `tsx` does not emit the design:paramtypes metadata
# NestJS dependency injection needs, and running the compiled output here would diverge from
# the documented local workflow for no benefit at this stage.
#
# NOT VERIFIED: no docker daemon was available where this was written, so this has never been
# built. Treat it as a starting point.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-install the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# FileStorageService writes here; docker-compose mounts a volume over it so uploads survive
# a container restart.
RUN mkdir -p uploads

EXPOSE 3000

CMD ["npx", "ts-node", "src/main.ts"]
