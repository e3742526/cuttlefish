import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { WeeklySchedule } from "../weekly-schedule"

function mockBrowserTimezone(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone,
  } as Intl.ResolvedDateTimeFormatOptions)
}

describe("WeeklySchedule timezone handling (TMP-CUT-004)", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("converts a job's fire time from its configured timezone to the browser's local zone", () => {
    vi.useFakeTimers()
    // January -> America/New_York is EST (UTC-5), no DST ambiguity.
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"))
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

    // 11:30 PM EST == 4:30 AM UTC the next day, so the grid should show the
    // converted hour/day, not the raw job-local "11p" / Monday.
    expect(screen.getByText("4a")).toBeTruthy()
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
    expect(pillCellIndex).toBe(2) // 0 = hour label, 1 = Monday, 2 = Tuesday
  })

  it("treats the schedule as browser-local when job.timezone is unset (existing behavior)", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"))
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
