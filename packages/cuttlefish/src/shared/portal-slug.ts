export function portalEmployeeSlug(portalName: string | null | undefined): string {
  return (portalName ?? "Cuttlefish")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "cuttlefish";
}
