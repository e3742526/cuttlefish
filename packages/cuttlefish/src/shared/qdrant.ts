import { QdrantClient } from "@qdrant/js-client-rest";

/**
 * Returns a Qdrant client configured via environment variables.
 *
 * Prefers an explicit `QDRANT_URL` (e.g. an `https://` endpoint behind an
 * authenticating proxy) so production deployments can use TLS + auth; falls back
 * to `QDRANT_HOST`/`QDRANT_PORT` for local development (loopback-bound by the
 * provided docker-compose). `QDRANT_API_KEY` is sent as the client credential and
 * should match the server-side `QDRANT__SERVICE__API_KEY` whenever the service is
 * reachable beyond localhost (AR-12).
 */
export function getQdrantClient(): QdrantClient {
  const host = process.env.QDRANT_HOST ?? "localhost";
  const port = process.env.QDRANT_PORT ?? "6333";
  const url = process.env.QDRANT_URL ?? `http://${host}:${port}`;
  return new QdrantClient({
    url,
    apiKey: process.env.QDRANT_API_KEY,
  });
}
