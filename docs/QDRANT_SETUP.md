# Qdrant Setup

This document describes how to add a local Qdrant vector database to the Cuttlefish development environment.

## Docker Compose

A `docker-compose.yml` is provided at the repository root. It defines a single service:

```yaml
version: "3.8"

services:
  qdrant:
    image: qdrant/qdrant:latest
    container_name: qdrant
    ports:
      - "6333:6333"
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

The service will be reachable at `http://localhost:6333`.

## Environment variables

Create a `.env` file (or copy from `.env.example`) and set:

```
QDRANT_HOST=localhost
QDRANT_PORT=6333
```

The helper `getQdrantClient()` in `packages/cuttlefish/src/shared/qdrant.ts` reads these variables and returns a configured `QdrantClient`.

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

For production deployments you may replace the Docker Compose service with a managed Qdrant instance and adjust the `QDRANT_HOST`/`QDRANT_PORT` accordingly.
