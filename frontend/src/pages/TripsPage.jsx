import { useParams } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@apollo/client";
import { Polyline } from "react-leaflet";
import { Box, Grid, List, ListItemButton, Typography, useTheme } from "@mui/material";
import { VEHICLE_TRIPS_QUERY, TRIP_ROUTE_QUERY } from "../graphql/queries/trips.js";
import { Map } from "../components/Map.jsx";
import { Loader } from "../components/Loader.jsx";
import { monoFont } from "../theme/index.js";

function formatDuration(seconds) {
  if (!seconds) return "—";
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDischarge(startLevel, endLevel) {
  if (startLevel == null || endLevel == null) return null;
  return `${startLevel - endLevel}% used`;
}

export function TripsPage() {
  const { vehicleId } = useParams();
  const { tokens } = useTheme();
  const { data, loading } = useQuery(VEHICLE_TRIPS_QUERY, {
    variables: { id: vehicleId, limit: 30 },
    fetchPolicy: "cache-and-network",
  });
  const [selectedId, setSelectedId] = useState(null);

  const trips = data?.vehicle?.trips || [];
  const selected = trips.find((t) => t.id === selectedId) || trips[0];

  const { data: routeData } = useQuery(TRIP_ROUTE_QUERY, {
    variables: { vehicleId, tripId: selected?.id },
    skip: !selected,
  });
  const route = routeData?.vehicle?.trip?.route || [];

  if (loading && !data) return <Loader />;

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={4}>
        <List sx={{ maxHeight: "70vh", overflow: "auto" }}>
          {trips.map((t) => (
            <ListItemButton
              key={t.id}
              selected={t.id === selected?.id}
              onClick={() => setSelectedId(t.id)}
              sx={{ display: "block", borderBottom: 1, borderColor: "divider", py: 1.25 }}
            >
              <Box display="flex" justifyContent="space-between" alignItems="baseline">
                <Typography variant="body2">{new Date(t.startTime).toLocaleString()}</Typography>
                <Typography sx={{ fontFamily: monoFont, fontSize: "0.9rem" }} color={tokens.drive}>
                  {t.distanceKm ? `${t.distanceKm.toFixed(1)} km` : "—"}
                </Typography>
              </Box>
              <Box display="flex" justifyContent="space-between" alignItems="baseline" mt={0.5}>
                <Typography variant="caption" color="text.secondary">
                  {formatDuration(t.durationSeconds)}
                  {t.efficiencyKmPerPercent ? ` · ${t.efficiencyKmPerPercent.toFixed(1)} km/%` : ""}
                </Typography>
                <Typography variant="caption" sx={{ fontFamily: monoFont }} color="text.secondary">
                  {[
                    formatDischarge(t.startBatteryLevel, t.endBatteryLevel),
                    t.energyUsedKwh ? `${t.energyUsedKwh.toFixed(1)} kWh` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Typography>
              </Box>
            </ListItemButton>
          ))}
          {trips.length === 0 && <Typography color="text.secondary">No trips recorded yet.</Typography>}
        </List>
      </Grid>
      <Grid item xs={12} md={8}>
        {!selected ? (
          <Typography color="text.secondary">Select a trip to see its route.</Typography>
        ) : selected.startLat == null || selected.startLng == null ? (
          <Typography color="text.secondary">This trip has no recorded location data.</Typography>
        ) : (
          // key={selected.id} forces a clean remount per trip — react-leaflet's
          // MapContainer only applies `center`/`zoom` on mount, so without this the
          // camera would stay put when switching between trips in different places.
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
            <Map key={selected.id} center={[selected.startLat, selected.startLng]} height="70vh">
              {route.length > 0 && (
                <Polyline positions={route.map((p) => [p.lat, p.lng])} pathOptions={{ color: tokens.drive, weight: 3 }} />
              )}
            </Map>
          </Box>
        )}
      </Grid>
    </Grid>
  );
}
