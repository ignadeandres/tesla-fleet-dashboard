import { useParams } from "react-router-dom";
import { useQuery, useMutation } from "@apollo/client";
import { Marker, Popup } from "react-leaflet";
import { Grid, Paper, Typography, Button, CircularProgress, Box, Chip, Alert } from "@mui/material";
import { VEHICLE_OVERVIEW_QUERY, REFRESH_VEHICLE_MUTATION } from "../graphql/queries/vehicle.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { Map } from "../components/Map.jsx";

function Stat({ label, value }) {
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5">{value}</Typography>
    </Paper>
  );
}

export function OverviewPage() {
  const { vehicleId } = useParams();
  const auth = useAuth();
  const { data, loading, refetch } = useQuery(VEHICLE_OVERVIEW_QUERY, { variables: { id: vehicleId } });
  const [refreshVehicle, { loading: refreshing, error: refreshError }] = useMutation(REFRESH_VEHICLE_MUTATION, {
    variables: { id: vehicleId },
    onCompleted: () => refetch(),
    onError: () => {}, // swallow here so it surfaces via `error` below instead of an unhandled rejection
  });

  if (loading && !data) return <CircularProgress />;
  const vehicle = data?.vehicle;
  const snap = vehicle?.latestSnapshot;

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={2} mb={2}>
        <Typography variant="h5">{vehicle?.displayName || vehicle?.vin}</Typography>
        {snap?.state && <Chip label={snap.state} size="small" />}
        <Box flexGrow={1} />
        {!auth.user?.isDemo && (
          <Button variant="outlined" disabled={refreshing} onClick={() => refreshVehicle()}>
            {refreshing ? "Refreshing…" : "Refresh Now"}
          </Button>
        )}
      </Box>

      {refreshError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {refreshError.message}
        </Alert>
      )}

      {!snap ? (
        <Typography color="text.secondary">No telemetry yet.</Typography>
      ) : (
        <>
          <Grid container spacing={2} mb={2}>
            <Grid item xs={6} sm={3}>
              <Stat label="Battery" value={snap.batteryLevel != null ? `${snap.batteryLevel}%` : "—"} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <Stat label="Range" value={snap.batteryRange != null ? `${Math.round(snap.batteryRange)} km` : "—"} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <Stat label="Odometer" value={snap.odometer != null ? `${Math.round(snap.odometer)} km` : "—"} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <Stat label="Locked" value={snap.locked ? "Yes" : "No"} />
            </Grid>
          </Grid>
          {snap.lat != null && snap.lng != null && (
            <Map center={[snap.lat, snap.lng]}>
              <Marker position={[snap.lat, snap.lng]}>
                <Popup>Last seen {new Date(snap.ts).toLocaleString()}</Popup>
              </Marker>
            </Map>
          )}
        </>
      )}
    </Box>
  );
}
