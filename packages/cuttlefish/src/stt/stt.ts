import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { STT_MODELS_DIR, TMP_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { assertFileIntegrity } from "../shared/file-integrity.js";

const execFileAsync = promisify(execFile);

const WHISPER_CLI = "whisper-cli";
const FFMPEG = "ffmpeg";

/** Valid Whisper language codes (ISO 639-1). */
export const WHISPER_LANGUAGES: Record<string, string> = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
  nl: "Dutch", sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian",
  uk: "Ukrainian", he: "Hebrew", da: "Danish", fi: "Finnish", hu: "Hungarian",
  no: "Norwegian", sk: "Slovak", hr: "Croatian", ca: "Catalan", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", ms: "Malay", tl: "Filipino", sr: "Serbian",
  lt: "Lithuanian", lv: "Latvian", sl: "Slovenian", et: "Estonian",
};

const WHISPER_MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const WHISPER_MODEL_BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}`;

interface WhisperModelAsset {
  filename: string;
  size: number;
  sha256: string;
}

const MODEL_ASSETS: Record<string, WhisperModelAsset> = {
  tiny: { filename: "ggml-tiny.bin", size: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
  "tiny.en": { filename: "ggml-tiny.en.bin", size: 77_704_715, sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f" },
  base: { filename: "ggml-base.bin", size: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
  "base.en": { filename: "ggml-base.en.bin", size: 147_964_211, sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
  small: { filename: "ggml-small.bin", size: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
  "small.en": { filename: "ggml-small.en.bin", size: 487_614_201, sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" },
  medium: { filename: "ggml-medium.bin", size: 1_533_763_059, sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208" },
  "medium.en": { filename: "ggml-medium.en.bin", size: 1_533_774_781, sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356" },
  "large-v3-turbo": { filename: "ggml-large-v3-turbo.bin", size: 1_624_555_275, sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69" },
};

let downloading = false;
let downloadProgress = 0;
const verifiedModelFiles = new Set<string>();

/** Ensure models directory exists. */
export function initStt(): void {
  fs.mkdirSync(STT_MODELS_DIR, { recursive: true });
  logger.info(`STT initialized, models dir: ${STT_MODELS_DIR}`);
}

export function getModelPath(model: string): string | null {
  const asset = MODEL_ASSETS[model];
  if (!asset) return null;
  const filePath = path.join(STT_MODELS_DIR, asset.filename);
  const stat = fs.statSync(filePath, {
    throwIfNoEntry: false,
  } as fs.StatSyncOptions & { throwIfNoEntry: false });
  return stat?.isFile() && stat.size === asset.size ? filePath : null;
}

async function verifyModelFile(model: string, filePath: string): Promise<void> {
  if (verifiedModelFiles.has(filePath)) return;
  const asset = MODEL_ASSETS[model];
  if (!asset) throw new Error(`Unknown model: ${model}`);
  await assertFileIntegrity(filePath, {
    size: asset.size,
    sha256: asset.sha256,
    label: `Whisper model '${model}'`,
  });
  verifiedModelFiles.add(filePath);
}

export interface SttStatus {
  available: boolean;
  model: string | null;
  downloading: boolean;
  progress: number;
  languages: string[];
}

/**
 * Resolve the languages list from config, with backwards compat for the
 * old `language: "en"` string format.
 */
export function resolveLanguages(sttConfig?: { language?: string; languages?: string[] }): string[] {
  if (sttConfig?.languages && sttConfig.languages.length > 0) return sttConfig.languages;
  if (sttConfig?.language) return [sttConfig.language];
  return ["en"];
}

export function getSttStatus(configModel?: string, languages?: string[]): SttStatus {
  const model = configModel || "small";
  const modelPath = getModelPath(model);
  return {
    available: modelPath !== null,
    model: modelPath ? model : null,
    downloading,
    progress: downloadProgress,
    languages: languages || ["en"],
  };
}

export async function downloadModel(
  model: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  if (downloading) throw new Error("Download already in progress");

  const asset = MODEL_ASSETS[model];
  if (!asset) throw new Error(`Unknown model: ${model}`);
  const url = `${WHISPER_MODEL_BASE}/${asset.filename}`;

  const existingPath = getModelPath(model);
  if (existingPath) {
    try {
      await verifyModelFile(model, existingPath);
      onProgress(100);
      return;
    } catch (err) {
      logger.warn(`Existing Whisper model '${model}' failed integrity verification and will be replaced: ${err instanceof Error ? err.message : err}`);
      try { fs.unlinkSync(existingPath); } catch { /* download will surface any remaining conflict */ }
    }
  }

  downloading = true;
  downloadProgress = 0;

  const destPath = path.join(STT_MODELS_DIR, asset.filename);
  const tmpPath = destPath + ".downloading";

  // getModelPath() rejects wrong-size files. Remove that stale destination
  // explicitly so the final rename is portable to platforms that will not
  // replace an existing file atomically.
  if (fs.existsSync(destPath)) {
    try { fs.unlinkSync(destPath); } catch { /* download will surface the conflict */ }
  }

  try {
    fs.mkdirSync(STT_MODELS_DIR, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      // Use curl for download — handles redirects, progress, and is reliable.
      // --speed-limit/--speed-time abort a stalled transfer (<1KB/s for 60s)
      // instead of holding the download (and its 1s progress poll) open forever.
      const curl = spawn("curl", [
        "-L", // follow redirects
        "--fail",
        "--proto", "=https",
        "--tlsv1.2",
        "--connect-timeout", "30",
        "--speed-limit", "1024", "--speed-time", "60",
        "-o", tmpPath,
        url,
      ]);

      // Poll file size for progress
      const progressInterval = setInterval(() => {
        try {
          const stat = fs.statSync(tmpPath, { throwIfNoEntry: false } as fs.StatSyncOptions & { throwIfNoEntry: false });
          if (stat && stat.size > 0) {
            downloadProgress = Math.min(95, Math.round(((stat.size as number) / asset.size) * 100));
            onProgress(downloadProgress);
          }
        } catch { /* file not created yet */ }
      }, 1000);

      curl.on("close", (code) => {
        clearInterval(progressInterval);
        if (code === 0) resolve();
        else reject(new Error(`curl exited with code ${code}`));
      });

      curl.on("error", (err) => {
        clearInterval(progressInterval);
        reject(err);
      });
    });

    await assertFileIntegrity(tmpPath, {
      size: asset.size,
      sha256: asset.sha256,
      label: `Whisper model '${model}'`,
    });

    // Rename temp file to final path
    fs.renameSync(tmpPath, destPath);
    verifiedModelFiles.add(destPath);

    downloadProgress = 100;
    onProgress(100);
    logger.info(`STT model '${model}' downloaded to ${destPath}`);
  } catch (err) {
    // Clean up partial download
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  } finally {
    downloading = false;
  }
}

/**
 * Convert audio to WAV (16kHz mono PCM) using ffmpeg.
 * whisper-cli requires this format.
 */
async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, "") + ".wav";
  await execFileAsync(FFMPEG, [
    "-i", inputPath,
    "-ar", "16000",    // 16kHz sample rate
    "-ac", "1",        // mono
    "-c:a", "pcm_s16le", // 16-bit PCM
    "-y",              // overwrite
    wavPath,
  ], {
    timeout: 2 * 60 * 1000, // 2 min timeout
  });
  return wavPath;
}

export async function transcribe(
  audioPath: string,
  model: string,
  language?: string,
): Promise<string> {
  const modelPath = getModelPath(model);
  if (!modelPath)
    throw new Error(`Model '${model}' not found. Download it first.`);
  await verifyModelFile(model, modelPath);

  // Convert to WAV if not already
  let wavPath = audioPath;
  let needsCleanup = false;
  if (!audioPath.endsWith(".wav")) {
    wavPath = await convertToWav(audioPath);
    needsCleanup = true;
  }

  try {
    const { stdout } = await execFileAsync(WHISPER_CLI, [
      "-m", modelPath,
      "-l", language || "en",
      "--no-timestamps",
      "-f", wavPath,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15 * 60 * 1000, // 15 min timeout for long recordings
    });

    // Clean up whisper output: remove blank lines, trim whitespace
    const text = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();

    return text;
  } finally {
    if (needsCleanup) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }
}
