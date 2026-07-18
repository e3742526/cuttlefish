import { describe, it, expect, afterEach, vi } from "vitest";
import { convertSlotToLocalTime, getBrowserTimezone, parseScheduleSlots } from "../cron-utils";

function mockBrowserTimezone(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone,
  } as Intl.ResolvedDateTimeFormatOptions);
}

describe("cron-utils timezone handling (TMP-CUT-004)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getBrowserTimezone reflects the runtime's resolved zone", () => {
    mockBrowserTimezone("Europe/London");
    expect(getBrowserTimezone()).toBe("Europe/London");
  });

  it("converts a job's schedule from its configured timezone to browser-local, regardless of mocked browser zone", () => {
    // January: America/New_York is EST (UTC-5), no DST ambiguity.
    const referenceDate = new Date("2026-01-15T12:00:00Z");
    mockBrowserTimezone("UTC");

    const slot = { hour: 9, minute: 0, days: [1] }; // 9:00 AM Monday, job-local
    const result = convertSlotToLocalTime(slot, "America/New_York", referenceDate);

    // 9:00 AM EST == 2:00 PM UTC, same day, no day shift.
    expect(result).toEqual({ hour: 14, minute: 0, days: [1] });
  });

  it("shifts the day when the timezone conversion crosses midnight", () => {
    const referenceDate = new Date("2026-01-15T12:00:00Z"); // EST, UTC-5
    mockBrowserTimezone("UTC");

    const slot = { hour: 23, minute: 30, days: [1] }; // 11:30 PM Monday, job-local
    const result = convertSlotToLocalTime(slot, "America/New_York", referenceDate);

    // 11:30 PM EST == 4:30 AM UTC the next day -> Monday(1) shifts to Tuesday(2).
    expect(result).toEqual({ hour: 4, minute: 30, days: [2] });
  });

  it("falls back to the raw slot when job.timezone is unset (existing browser-local behavior)", () => {
    mockBrowserTimezone("Asia/Tokyo");
    const slot = { hour: 8, minute: 15, days: [0, 3] };
    expect(convertSlotToLocalTime(slot, undefined)).toEqual(slot);
  });

  it("returns the raw slot unchanged when job timezone matches the browser zone", () => {
    mockBrowserTimezone("America/New_York");
    const slot = { hour: 6, minute: 45, days: [5] };
    expect(convertSlotToLocalTime(slot, "America/New_York")).toEqual(slot);
  });

  it("falls back to the raw slot for an unresolvable timezone instead of throwing", () => {
    mockBrowserTimezone("UTC");
    const slot = { hour: 10, minute: 0, days: [2] };
    expect(convertSlotToLocalTime(slot, "Not/A_Real_Zone")).toEqual(slot);
  });

  it("parseScheduleSlots is unaffected (still parses raw job-local cron fields)", () => {
    expect(parseScheduleSlots("30 23 * * 1")).toEqual({ hour: 23, minute: 30, days: [1] });
  });
});
