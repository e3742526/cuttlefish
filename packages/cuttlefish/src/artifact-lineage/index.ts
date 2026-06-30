import { ARTIFACT_LINEAGE_DB } from "../shared/paths.js";
import { ArtifactLineageStore } from "./store.js";

let singleton: { dbPath: string; store: ArtifactLineageStore } | undefined;
let initializing = false;

export * from "./store.js";
export * from "./types.js";

export function getArtifactLineage(dbPath = ARTIFACT_LINEAGE_DB): ArtifactLineageStore {
  if (singleton && singleton.dbPath === dbPath) {
    return singleton.store;
  }
  // Guard against re-entrant double-init: if a second call arrives while the
  // first is still inside ArtifactLineageStore.open(), return the in-progress
  // singleton once it is available.  Because Node.js is single-threaded the
  // flag is sufficient to prevent double-open within one event loop turn.
  if (initializing) {
    // Spin is unreachable in practice (open() is synchronous) but acts as a
    // clear documentation contract that re-entry is not allowed.
    throw new Error("lineage: getArtifactLineage() called re-entrantly during initialization");
  }
  initializing = true;
  try {
    singleton?.store.close();
    singleton = {
      dbPath,
      store: ArtifactLineageStore.open(dbPath),
    };
    return singleton.store;
  } finally {
    initializing = false;
  }
}

export function resetArtifactLineageForTest(): void {
  singleton?.store.close();
  singleton = undefined;
}
