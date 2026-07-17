import crypto from "node:crypto";
import fs from "node:fs";

export interface ExpectedFileIntegrity {
  sha256: string;
  size: number;
  label?: string;
}
/** Hash a file without loading large model assets into the Node heap. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verify downloaded bytes before they are renamed into a live model path.
 * Exact size catches obvious truncation cheaply; SHA-256 authenticates the
 * complete payload against the repository-pinned upstream release metadata.
 */
export async function assertFileIntegrity(
  filePath: string,
  expected: ExpectedFileIntegrity,
): Promise<void> {
  const label = expected.label ?? filePath;
  const stat = fs.statSync(filePath, {
    throwIfNoEntry: false,
  } as fs.StatSyncOptions & { throwIfNoEntry: false });
  const actualSize = stat?.size ?? 0;
  if (actualSize !== expected.size) {
    throw new Error(
      `${label} size mismatch (${actualSize} bytes, expected ${expected.size})`,
    );
  }
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expected.sha256.toLowerCase()) {
    throw new Error(
      `${label} SHA-256 mismatch (got ${actualSha256}, expected ${expected.sha256})`,
    );
  }
}
