const MI_TO_KM = 1.609344;

// Confirmed against a real vehicle: Tesla's API returns vehicle_state.odometer,
// charge_state.battery_range, and drive_state.speed in miles/mph unconditionally —
// gui_settings.gui_distance_units (which reflects the car's own dash display setting)
// does NOT indicate the unit of these fields, despite what Tesla's own field naming
// suggests. Always convert; don't gate on that flag.
export function toKm(value) {
  return value == null ? value : value * MI_TO_KM;
}
