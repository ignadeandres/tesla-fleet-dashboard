// Routes are declared per-section (/v/:vehicleId/overview, /v/:vehicleId/trips, ...)
// rather than with a single :section param, so this can't be read via useParams().
export function sectionFromPath(pathname) {
  return pathname.split("/")[3] || "overview";
}
