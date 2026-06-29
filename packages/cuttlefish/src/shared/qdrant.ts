import { QdrantClient } from "@qdrant/js-client-rest";

/**
 * Returns a Qdrant client configured via environment variables.
 * Defaults to localhost:6333 if not provided.
 */
export function getQdrantClient(): QdrantClient {
  const host = process.env.QDRANT_HOST ?? "localhost";
  const port = process.env.QDRANT_PORT ?? "6333";
  const url = `http://${host}:${port}`;
  return new QdrantClient({
  url,
  apiKey: process.env.QDRANT_API_KEY,
});
}
