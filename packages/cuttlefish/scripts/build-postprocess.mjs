#!/usr/bin/env node
// Cross-platform replacement for the POSIX shell chain previously inlined in
// package.json's "build" script (rm -rf/cp -r don't run under cmd.exe on Windows).

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const talkSrc = "src/talk";
const talkDist = "dist/src/talk";
mkdirSync(talkDist, { recursive: true });
if (existsSync(talkSrc)) {
  for (const name of readdirSync(talkSrc)) {
    if (name.endsWith(".md") || name.endsWith(".py")) {
      copyFileSync(join(talkSrc, name), join(talkDist, name));
    }
  }
}

const webOut = "../web/out";
const webDist = "dist/web";
rmSync(webDist, { recursive: true, force: true });
if (existsSync(webOut)) {
  cpSync(webOut, webDist, { recursive: true });
}
