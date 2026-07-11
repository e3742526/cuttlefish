# Qdrant Setup

This document describes how to add a local Qdrant vector database to the Cuttlefish development environment.

## Docker Compose

A `docker-compose.yml` is provided at the repository root. It defines a single service:

```yaml
version: "3.8"

services:
  qdrant:
    image: qdrant/qdrant:v1.18.2
    container_name: qdrant
    ports:
      - "127.0.0.1:6333:6333"
    environment:
      QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:-}
    volumes:
      - qdrant_data:/qdrant/storage
    restart: unless-stopped

volumes:
  qdrant_data:
```

Start it with:

```bash
docker compose up -d qdrant
```

The service will be reachable at `http://localhost:6333` **from this host only**.

## Security: never expose Qdrant unauthenticated

Qdrant has **no authentication or TLS by default**. The compose file above binds
the port to `127.0.0.1`, so the vector store is reachable only from the local
host. Do **not** change the mapping to `"6333:6333"` (which publishes on all
interfaces, `0.0.0.0`) unless every one of the following is true:

- `QDRANT_API_KEY` is set to a strong secret — docker-compose wires it into
  `QDRANT__SERVICE__API_KEY`, so the server rejects requests without a matching
  `api-key` header; and
- the endpoint is fronted by a TLS-terminating, authenticating reverse proxy (or
  is confined to a trusted private network segment).

For remote/managed deployments, prefer setting `QDRANT_URL` to the `https://`
endpoint of that proxy rather than exposing the container port directly.

## Environment variables

Create a `.env` file (or copy from `.env.example`) and set:

```
QDRANT_HOST=localhost
QDRANT_PORT=6333
# Required whenever Qdrant is reachable beyond localhost; must match the server.
QDRANT_API_KEY=<strong-secret>
# Optional: full https URL behind an authenticating proxy (overrides HOST/PORT).
# QDRANT_URL=https://qdrant.internal.example:6333
```

The helper `getQdrantClient()` in `packages/cuttlefish/src/shared/qdrant.ts` reads
these variables (preferring `QDRANT_URL` when set) and returns a configured
`QdrantClient` that sends `QDRANT_API_KEY` as its credential.

## Basic usage example

```ts
import { getQdrantClient } from "./shared/qdrant";

async function example() {
  const client = getQdrantClient();
  const collectionName = "demo";
  // Create collection if it does not exist
  await client.collections.create(collectionName, { vectors: { size: 128, distance: "Cosine" } }).catch(() => {});

  // Insert a single vector
  await client.points.upsert(collectionName, {
    points: [{ id: 1, vector: new Array(128).fill(0.5) }],
  });

  // Search similar vectors
  const result = await client.points.search(collectionName, {
    vector: new Array(128).fill(0.5),
    limit: 5,
  });
  console.log(result);
}

example();
```

## Integration points

* Add the `@qdrant/js-client-rest` dependency is already listed in `packages/cuttlefish/package.json`.
* Import `getQdrantClient()` wherever vector storage or similarity search is required.
* Ensure the Docker container is running before invoking any Qdrant‑related code.

---

For production deployments you may replace the Docker Compose service with a managed Qdrant instance and point `QDRANT_URL` (or `QDRANT_HOST`/`QDRANT_PORT`) at it — always over TLS with `QDRANT_API_KEY` set, per the security note above.
