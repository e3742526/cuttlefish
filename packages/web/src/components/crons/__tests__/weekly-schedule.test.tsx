import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { WeeklySchedule } from "../weekly-schedule"
import { convertSlotToLocalTime } from "@/lib/cron-utils"

function mockBrowserTimezone(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone,
  } as Intl.ResolvedDateTimeFormatOptions)
}

function formatHourShort(hour: number): string {
  if (hour === 0 || hour === 24) return "12a"
  if (hour === 12) return "12p"
  return hour < 12 ? `${hour}a` : `${hour - 12}p`
}

function gridCellIndex(day: number): number {
  return day === 0 ? 7 : day
}

describe("WeeklySchedule timezone handling (TMP-CUT-004)", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("converts a job's fire time from its configured timezone to the browser's local zone", () => {
    mockBrowserTimezone("UTC")

    const crons = [
      {
        id: "job-1",
        name: "Nightly Report",
        schedule: "30 23 * * 1", // Monday 11:30 PM, job-local (America/New_York)
        enabled: true,
        timezone: "America/New_York",
      },
    ]

    const { getByTestId } = render(<WeeklySchedule crons={crons} />)

    // Keep exact DST arithmetic in cron-utils' explicit-date tests. This
    // component regression proves that the grid consumes the conversion using
    // the same live browser clock, without fake timers replacing Intl's zone.
    const expected = convertSlotToLocalTime({ hour: 23, minute: 30, days: [1] }, "America/New_York")
    expect(screen.getByText(formatHourShort(expected.hour))).toBeTruthy()
    expect(screen.queryByText("11p")).toBeNull()

    const pill = screen.getByRole("button", { name: /Nightly Report/ })
    expect(pill.textContent).toContain(":30")

    // The pill should land in the Tuesday column. Grid children are: 8 header
    // cells, then one `.contents` wrapper per active hour row (a real DOM
    // node, just CSS display:contents), each holding [hour-label, Mon, ..., Sun].
    const grid = getByTestId("weekly-schedule-grid")
    const hourRow = grid.children[8]
    const dayCells = Array.from(hourRow.children)
    const pillCellIndex = dayCells.findIndex((cell) => cell.contains(pill))
    expect(pillCellIndex).toBe(gridCellIndex(expected.days[0]))
  })

  it("treats the schedule as browser-local when job.timezone is unset (existing behavior)", () => {
    mockBrowserTimezone("America/Los_Angeles")

    const crons = [
      {
        id: "job-2",
        name: "Morning Sync",
        schedule: "0 9 * * 2", // Tuesday 9:00 AM, no timezone configured
        enabled: true,
      },
    ]

    render(<WeeklySchedule crons={crons} />)

    // No conversion should happen: the raw cron hour is shown as-is.
    expect(screen.getByText("9a")).toBeTruthy()
  })

  it("renders a label indicating the local display timezone", () => {
    mockBrowserTimezone("Europe/London")

    const crons = [
      { id: "job-3", name: "Job", schedule: "0 8 * * 1", enabled: true },
    ]

    render(<WeeklySchedule crons={crons} />)

    expect(screen.getByText(/Europe\/London/)).toBeTruthy()
  })
})
