import { useParams } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@apollo/client";
import { Polyline } from "react-leaflet";
import {
  Box,
  Grid,
  List,
  ListItemButton,
  ListItemText,
  Typography,
  CircularProgress,
} from "@mui/material";
import { VEHICLE_TRIPS_QUERY, TRIP_ROUTE_QUERY } from "../graphql/queries/trips.js";
import { Map } from "../components/Map.jsx";

function formatDuration(seconds) {
  if (!seconds) return "—";
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function TripsPage() {
  const { vehicleId } = useParams();
  const { data, loading } = useQuery(VEHICLE_TRIPS_QUERY, { variables: { id: vehicleId, limit: 30 } });
  const [selectedId, setSelectedId] = useState(null);

  const trips = data?.vehicle?.trips || [];
  const selected = trips.find((t) => t.id === selectedId) || trips[0];

  const { data: routeData } = useQuery(TRIP_ROUTE_QUERY, {
    variables: { vehicleId, tripId: selected?.id },
    skip: !selected,
  });
  const route = routeData?.vehicle?.trip?.route || [];

  if (loading && !data) return <CircularProgress />;

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={4}>
        <List sx={{ maxHeight: 500, overflow: "auto" }}>
          {trips.map((t) => (
            <ListItemButton key={t.id} selected={t.id === selected?.id} onClick={() => setSelectedId(t.id)}>
              <ListItemText
                primary={new Date(t.startTime).toLocaleString()}
                secondary={`${t.distanceKm ? t.distanceKm.toFixed(1) + " km" : "—"} · ${formatDuration(t.durationSeconds)}`}
              />
            </ListItemButton>
          ))}
          {trips.length === 0 && <Typography color="text.secondary">No trips recorded yet.</Typography>}
        </List>
      </Grid>
      <Grid item xs={12} md={8}>
        {selected?.startLat != null && selected?.startLng != null && (
          // key={selected.id} forces a clean remount per trip — react-leaflet's
          // MapContainer only applies `center`/`zoom` on mount, so without this the
          // camera would stay put when switching between trips in different places.
          <Map key={selected.id} center={[selected.startLat, selected.startLng]} height={500}>
            {route.length > 0 && <Polyline positions={route.map((p) => [p.lat, p.lng])} />}
          </Map>
        )}
      </Grid>
    </Grid>
  );
}
