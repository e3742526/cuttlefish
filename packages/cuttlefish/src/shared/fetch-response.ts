export class ResponseBodyTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number,
  ) {
    super(`Response body exceeded ${maxBytes} bytes (observed at least ${observedBytes})`);
    this.name = "ResponseBodyTooLargeError";
  }
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Read a fetch response while enforcing a hard byte limit for declared and streamed bodies. */
export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const declared = declaredContentLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyTooLargeError(maxBytes, declared);
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError(maxBytes, total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return (await readResponseBuffer(response, maxBytes)).toString("utf8");
}

export async function readResponseJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  return JSON.parse(await readResponseText(response, maxBytes)) as T;
}
