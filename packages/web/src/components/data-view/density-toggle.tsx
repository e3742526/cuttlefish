import type { Density } from "./use-view-preferences"
import { cn } from "@/lib/utils"

interface DensityToggleProps {
  density: Density
  onChange: (density: Density) => void
  className?: string
}

const OPTIONS: { key: Density; label: string }[] = [
  { key: "comfortable", label: "Comfortable" },
  { key: "compact", label: "Compact" },
]

export function DensityToggle({ density, onChange, className }: DensityToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Row density"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full bg-[var(--fill-secondary)] p-0.5",
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const isActive = density === option.key
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.key)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[length:var(--text-caption1)] font-medium transition-colors",
              isActive
                ? "bg-[var(--accent-fill)] text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
