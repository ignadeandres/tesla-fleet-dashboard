const MI_TO_KM = 1.609344;

// Tesla's numeric distance/speed fields mirror whatever unit the car's own touchscreen
// is set to (mi or km) — there's no fixed unit. This dashboard always stores/shows km,
// independent of what the car's own display happens to be set to.
export function isMilesUnit(raw) {
  return (raw?.gui_settings?.gui_distance_units || "").toLowerCase().includes("mi");
}

export function toKm(value, raw) {
  return value == null ? value : isMilesUnit(raw) ? value * MI_TO_KM : value;
}
