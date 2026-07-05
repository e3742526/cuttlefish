import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { CronJob } from "../../../shared/types.js";
import { CRON_RUNS } from "../../../shared/paths.js";
import { logger } from "../../../shared/logger.js";
import { loadJobs, saveJobs } from "../../../cron/jobs.js";
import { reloadScheduler, startCronJobRun } from "../../../cron/scheduler.js";
import { buildCronJob, patchCronJob } from "../../../cron/validation.js";
import { readJsonBody } from "../../http-helpers.js";
import { readJsonlTail } from "../../jsonl-tail.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";

function serializeCronJob(job: CronJob, lastRun: Record<string, unknown> | null = null): Record<string, unknown> {
  const scheduleValid = cron.validate(job.schedule);
  return {
    ...job,
    lastRun,
    scheduleValid,
    scheduleError: scheduleValid ? null : `Invalid cron schedule: ${job.schedule}`,
  };
}

export async function handleCronRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/cron/:id/runs", pathname);
  if (method === "GET" && params) {
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "", 10) || 50));
    const runId = url.searchParams.get("runId");
    const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
    const { entries, skipped } = await readJsonlTail(runFile, runId ? 500 : limit * 4);
    const seen = new Set<string>();
    const runs = [];
    for (const entry of entries as Record<string, unknown>[]) {
      const id = typeof entry.runId === "string" ? entry.runId : JSON.stringify(entry);
      if (runId && id !== runId) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      runs.push(entry);
      if (runs.length >= limit) break;
    }
    if (skipped) logger.warn(`GET /api/cron/${params.id}/runs: skipped ${skipped} corrupt line(s)`);
    json(res, runs);
    return true;
  }

  if (method === "GET" && pathname === "/api/cron") {
    const jobs = loadJobs();
    const enriched = await Promise.all(jobs.map(async (job) => {
      const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
      const { entries } = await readJsonlTail(runFile, 1);
      return serializeCronJob(job, (entries[0] as Record<string, unknown> | undefined) ?? null);
    }));
    json(res, enriched);
    return true;
  }

  if (method === "POST" && pathname === "/api/cron") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const jobs = loadJobs();
    let newJob: CronJob;
    try {
      newJob = buildCronJob(parsed.body);
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : "Invalid cron job");
      return true;
    }
    jobs.push(newJob);
    saveJobs(jobs);
    reloadScheduler(jobs, context.getConfig(), context.connectors);
    json(res, newJob, 201);
    return true;
  }

  params = matchRoute("/api/cron/:id", pathname);
  if (method === "PUT" && params) {
    const routeParams = params;
    const jobs = loadJobs();
    const idx = jobs.findIndex((job) => job.id === routeParams.id);
    if (idx === -1) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    try {
      jobs[idx] = { ...patchCronJob(jobs[idx], parsed.body), id: routeParams.id };
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : "Invalid cron update");
      return true;
    }
    saveJobs(jobs);
    reloadScheduler(jobs, context.getConfig(), context.connectors);
    json(res, jobs[idx]);
    return true;
  }

  params = matchRoute("/api/cron/:id", pathname);
  if (method === "DELETE" && params) {
    const routeParams = params;
    const jobs = loadJobs();
    const idx = jobs.findIndex((job) => job.id === routeParams.id);
    if (idx === -1) {
      notFound(res);
      return true;
    }
    const removed = jobs.splice(idx, 1)[0];
    saveJobs(jobs);
    reloadScheduler(jobs, context.getConfig(), context.connectors);
    json(res, { deleted: removed.id, name: removed.name });
    return true;
  }

  params = matchRoute("/api/cron/:id/trigger", pathname);
  if (method === "POST" && params) {
    const jobs = loadJobs();
    const job = jobs.find((entry) => entry.id === params.id);
    if (!job) {
      notFound(res);
      return true;
    }
    if (!job.enabled) {
      json(res, { error: "Cron job is disabled", jobId: job.id, status: "disabled" }, 409);
      return true;
    }

    logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);
    const started = startCronJobRun(job, context.sessionManager, context.getConfig(), context.connectors, "manual");
    if (!started.started) {
      json(res, { error: "Cron job already running", jobId: job.id, status: started.run.status, runId: started.run.runId }, 409);
      return true;
    }
    started.promise.catch((err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`));
    json(res, {
      status: "running",
      triggered: true,
      runId: started.runId,
      jobId: job.id,
      name: job.name,
      employee: job.employee,
      message: `Cron job "${job.name}" triggered manually`,
    }, 202);
    return true;
  }

  return false;
}
