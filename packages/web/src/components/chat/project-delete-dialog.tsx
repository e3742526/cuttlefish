import { useEffect, useState } from "react"
import type { ProjectSummary } from "@cuttlefish/contracts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function ProjectDeleteDialog({
  project,
  open,
  deleting,
  onOpenChange,
  onConfirm,
}: {
  project: ProjectSummary
  open: boolean
  deleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (confirmation: string) => Promise<void>
}) {
  const [confirmation, setConfirmation] = useState("")
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) { setConfirmation(""); setError(null) }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete project permanently?</DialogTitle>
          <DialogDescription>
            This permanently deletes “{project.title}” and all {project.sessionCount} sessions in its tree. It is unavailable while any member is active or awaiting action.
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-2 text-xs text-[var(--text-secondary)]">
          <span>Type the exact project title to confirm:</span>
          <strong className="block break-words text-foreground">{project.title}</strong>
          <input
            value={confirmation}
            onChange={(event) => { setConfirmation(event.target.value); setError(null) }}
            aria-label="Project deletion confirmation"
            className="focus-ring h-10 w-full rounded-lg border border-[var(--separator)] bg-[var(--bg-secondary)] px-3 text-sm outline-none"
          />
        </label>
        {error ? <p role="alert" className="text-xs text-[var(--system-red)]">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={deleting || confirmation !== project.title}
            onClick={() => void onConfirm(confirmation).catch((reason) => setError(reason instanceof Error ? reason.message : "Deletion failed"))}
          >
            {deleting ? "Deleting…" : `Delete ${project.sessionCount} sessions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

