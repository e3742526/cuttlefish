import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-files-sec-"));
process.env.CUTTLEFISH_HOME = tmpHome;

type Files = typeof import("../files.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  files = await import("../files.js");
});

describe("file read secret protection", () => {
  it("blocks high-risk secret paths while allowing normal project files", () => {
    const secretDir = path.join(tmpHome, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, "api.txt");
    const normal = path.join(tmpHome, "notes.txt");
    fs.writeFileSync(secret, "TOKEN=should-not-leak");
    fs.writeFileSync(normal, "hello");

    expect(files.assessFileRead(secret, { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".ssh", "id_rsa"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(tmpHome, "project", ".env.local"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(tmpHome, "project", ".envrc"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(normal, { authenticated: true }).allowed).toBe(true);
  });

  it("blocks the gateway admin-token file and the expanded credential blocklist (CF2-101/CF2-201)", () => {
    expect(files.assessFileRead(paths.GATEWAY_INFO_FILE, { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".claude", ".credentials.json"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".aws", "credentials"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".kube", "config"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".docker", "config.json"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".npmrc"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".netrc"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".git-credentials"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"), { authenticated: true }).allowed).toBe(false);
    // A same-named "config" file outside .kube must not be swept up by the scoped rule.
    expect(files.assessFileRead(path.join(tmpHome, "project", "config"), { authenticated: true }).allowed).toBe(true);
  });

  it("blocks symlink bypasses that point at denied secret files", () => {
    const secretDir = path.join(tmpHome, "secrets");
    const secret = path.join(secretDir, "plain-name.txt");
    const link = path.join(tmpHome, "project", "notes.txt");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(secret, "raw-token-that-should-not-leak");
    fs.symlinkSync(secret, link);

    expect(files.assessFileRead(link, { authenticated: true }).allowed).toBe(false);
  });

  it("redacts sensitive text content before returning it to the UI", () => {
    const file = path.join(tmpHome, "output.txt");
    fs.writeFileSync(file, "OPENAI_API_KEY=sk-test...cdef\nhello");
    const c = files.classifyFile(file);
    expect(c.content).toContain("[REDACTED]");
    expect(c.content).not.toContain("sk-test...cdef");
  });
});

describe("file upload side effects", () => {
  it("rejects custom upload paths outside managed storage", () => {
    expect(files.resolveCustomUploadPath("/tmp/owned.txt")).toBeNull();
    expect(files.resolveCustomUploadPath(path.join(paths.FILES_DIR, "..", "..", "owned.txt"))).toBeNull();
  });

  it("allows custom upload paths only inside managed storage roots", () => {
    const managed = path.join(paths.FILES_DIR, "custom", "note.txt");
    expect(files.resolveCustomUploadPath(managed)).toBe(path.resolve(managed));
  });

  it("keeps automatic file opening disabled unless explicitly opted in", () => {
    expect(files.allowUploadedFileOpen({ getConfig: () => ({ gateway: {} }) } as any)).toBe(false);
    expect(files.allowUploadedFileOpen({ getConfig: () => ({ gateway: { allowFileOpen: true } }) } as any)).toBe(true);
  });

  it("does not invent a custom remote filesystem path unless explicitly requested", () => {
    expect(files.buildRemoteUploadBody("note.txt", Buffer.from("hello"), null)).toEqual({
      filename: "note.txt",
      content: Buffer.from("hello").toString("base64"),
    });
    expect(files.buildRemoteUploadBody("note.txt", Buffer.from("hello"), "~/inbox/note.txt")).toEqual({
      filename: "note.txt",
      content: Buffer.from("hello").toString("base64"),
      path: "~/inbox/note.txt",
    });
  });

  it("adds remote bearer auth only for configured remotes with a token", () => {
    const config = {
      remotes: {
        prod: { url: "https://cuttlefish.example.test/", token: "remote-token" },
        demo: { url: "https://demo.example.test" },
      },
    };

    expect(files.remoteUploadHeaders("https://cuttlefish.example.test", config as any)).toEqual({
      "Content-Type": "application/json",
      authorization: "Bearer remote-token",
    });
    expect(files.remoteUploadHeaders("https://demo.example.test", config as any)).toEqual({
      "Content-Type": "application/json",
    });
  });
});
