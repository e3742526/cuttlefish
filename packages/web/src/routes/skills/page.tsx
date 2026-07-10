
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { renderMarkdown } from "@/lib/sanitize";
import { PageLayout } from "@/components/page-layout";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Zap } from "lucide-react";
import { useSettings } from "@/routes/settings-provider";
import { useToast } from "@/components/ui/toast";

interface Skill {
  name: string;
  description?: string;
  content?: string;
  [key: string]: unknown;
}

export default function SkillsPage() {
  useBreadcrumbs([{ label: 'Skills' }])
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Cuttlefish";
  const { pushToast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [skillContentError, setSkillContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Tracks which skill's content fetch is the most recently requested, so a
  // slower earlier response can't overwrite a newer selection if a user
  // clicks multiple skill cards in quick succession.
  const activeSkillRef = useRef<string | null>(null);

  const loadSkills = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getSkills()
      .then((data) => setSkills(data as Skill[]))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load skills."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  function openSkill(skill: Skill) {
    activeSkillRef.current = skill.name;
    setSelectedSkill(skill);
    setDialogOpen(true);
    setContentLoading(true);
    setSkillContentError(null);
    setSkillContent(null);
    api
      .getSkill(skill.name)
      .then((data) => {
        if (activeSkillRef.current !== skill.name) return;
        const d = data as Record<string, unknown>;
        setSkillContent(
          (d.content as string) ||
            (d.skillMd as string) ||
            JSON.stringify(d, null, 2),
        );
      })
      .catch((err) => {
        if (activeSkillRef.current !== skill.name) return;
        setSkillContentError(err instanceof Error ? err.message : "Failed to load skill content.");
      })
      .finally(() => {
        if (activeSkillRef.current === skill.name) setContentLoading(false);
      });
  }

  function closeDialog() {
    activeSkillRef.current = null;
    setDialogOpen(false);
    setSelectedSkill(null);
    setSkillContent(null);
    setSkillContentError(null);
  }

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto p-[var(--space-6)]">
        {/* Header */}
        <div className="flex items-center justify-between mb-[var(--space-6)]">
          <div>
            <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-1)]">
              Skills
            </h2>
            <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
              Capabilities and learned behaviors
            </p>
          </div>
          <button
            onClick={() =>
              pushToast({
                title: "Create a skill from chat",
                description: `Chat with ${portalName} and ask it to learn something new.`,
              })
            }
            className="py-[var(--space-2)] px-[var(--space-4)] rounded-[var(--radius-md,12px)] text-[var(--accent)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-medium)]"
            style={{
              background:
                "color-mix(in srgb, var(--accent) 12%, transparent)",
            }}
          >
            + Create Skill
          </button>
        </div>

        {error && (
          <ErrorState className="mb-[var(--space-4)]" message={`Failed to load skills: ${error}`} onRetry={loadSkills} />
        )}

        {loading ? (
          <div role="status" aria-live="polite" className="text-center p-[var(--space-8)] text-[var(--text-tertiary)] text-[length:var(--text-body)]">
            Loading...
          </div>
        ) : skills.length === 0 && !error ? (
          <EmptyState
            icon={Zap}
            title="No skills yet"
            description={`Chat with ${portalName} to teach new skills.`}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[var(--space-4)]">
            {skills.map((skill) => (
              <Card
                key={skill.name}
                className="py-4 cursor-pointer transition-colors hover:border-[var(--accent)]"
                onClick={() => openSkill(skill)}
              >
                <CardContent className="flex flex-col gap-3">
                  <div
                    className="w-10 h-10 rounded-[var(--radius-md,12px)] flex items-center justify-center text-[var(--system-yellow)]"
                    style={{
                      background:
                        "color-mix(in srgb, var(--system-yellow) 12%, transparent)",
                    }}
                  >
                    <Zap size={20} />
                  </div>
                  <div>
                    <p className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] mb-0.5">
                      {skill.name}
                    </p>
                    <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] line-clamp-2">
                      {skill.description || "No description"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Skill detail dialog */}
        <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{selectedSkill?.name ?? "Skill"}</DialogTitle>
              <DialogDescription>
                {selectedSkill?.description || "Skill details"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto py-[var(--space-2)]">
              {contentLoading ? (
                <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
                  Loading...
                </p>
              ) : skillContentError ? (
                <ErrorState
                  message={skillContentError}
                  onRetry={selectedSkill ? () => openSkill(selectedSkill) : undefined}
                />
              ) : skillContent ? (
                <div
                  className="text-[length:var(--text-body)] leading-[1.7] text-[var(--text-secondary)]"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(skillContent),
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </PageLayout>
  );
}
