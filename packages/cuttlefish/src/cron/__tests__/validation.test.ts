import { describe, expect, it } from "vitest";
import { buildCronJob, patchCronJob, sanitizeCronLogId } from "../validation.js";
import type { CronJob } from "../../shared/types.js";

function baseJob(): CronJob {
  return {
    id: "job-1",
    name: "Hourly",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "status",
  };
}

describe("cron job validation", () => {
  it("rejects unknown create and update fields", () => {
    expect(() => buildCronJob({ name: "x", prompt: "x", unsafe: true })).toThrow(/Unknown cron fields: unsafe/);
    expect(() => patchCronJob(baseJob(), { prompt: "x", id: "new-id" })).toThrow(/Unknown cron fields: id/);
  });

  it("rejects invalid schedules and timezones", () => {
    expect(() => buildCronJob({ schedule: "not a cron", prompt: "x" })).toThrow(/schedule/);
    expect(() => buildCronJob({ schedule: "0 * * * *", timezone: "Mars/Base" })).toThrow(/timezone/);
    expect(() => patchCronJob(baseJob(), { schedule: "" })).toThrow(/schedule/);
  });

  it("accepts validated fields and delivery targets", () => {
    const job = buildCronJob({
      name: "Daily",
      enabled: false,
      schedule: "0 9 * * *",
      timezone: "America/New_York",
      prompt: "daily report",
      delivery: { connector: "slack", channel: "#ops" },
    });

    expect(job).toMatchObject({
      name: "Daily",
      enabled: false,
      schedule: "0 9 * * *",
      timezone: "America/New_York",
      prompt: "daily report",
      delivery: { connector: "slack", channel: "#ops" },
    });
  });
});

describe("sanitizeCronLogId", () => {
  it("strips embedded newlines and control characters so a job id cannot forge fake log entries", () => {
    const malicious = 'job-1\n2026-07-17T00:00:00.000Z [ERROR] fake entry"}\n{"runId":"evil';
    const sanitized = sanitizeCronLogId(malicious);
    expect(sanitized).not.toContain("\n");
    expect(sanitized).not.toContain("\r");
  });

  it("strips path separators and leading dot segments so a job id cannot escape the run-log directory", () => {
    expect(sanitizeCronLogId("../../etc/passwd")).not.toContain("/");
    expect(sanitizeCronLogId("../../etc/passwd")).not.toMatch(/^\.\./);
    expect(sanitizeCronLogId("a/b\\c")).not.toMatch(/[/\\]/);
  });

  it("leaves ordinary job ids untouched", () => {
    expect(sanitizeCronLogId("daily-digest_v2")).toBe("daily-digest_v2");
  });

  it("falls back to a placeholder for an id that sanitizes to empty", () => {
    expect(sanitizeCronLogId("")).toBeTruthy();
    expect(sanitizeCronLogId("..")).toBeTruthy();
  });
});
