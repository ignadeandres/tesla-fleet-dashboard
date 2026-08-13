import { useParams } from "react-router-dom";
import { useQuery, useMutation } from "@apollo/client";
import { Marker, Popup } from "react-leaflet";
import { Grid, Typography, Button, Box, Chip, Alert, useTheme } from "@mui/material";
import { VEHICLE_OVERVIEW_QUERY, REFRESH_VEHICLE_MUTATION } from "../graphql/queries/vehicle.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { Map } from "../components/Map.jsx";
import { ChargeRail } from "../components/ChargeRail.jsx";
import { Loader } from "../components/Loader.jsx";
import { monoFont } from "../theme/index.js";

// Readout tile: mono numeral (instrument-style) + label, hairline-divided instead
// of a card shadow. `rail` renders the ChargeRail gauge under the battery reading.
function Stat({ label, value, caption, rail }) {
  return (
    <Box sx={{ borderLeft: 2, borderColor: "divider", pl: 2, py: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </Typography>
      <Typography sx={{ fontFamily: monoFont, fontSize: "1.75rem", fontWeight: 500, lineHeight: 1.2 }}>
        {value}
      </Typography>
      {rail && <Box mt={1}>{rail}</Box>}
      {caption && (
        <Typography variant="caption" color="text.secondary" display="block">
          {caption}
        </Typography>
      )}
    </Box>
  );
}

export function OverviewPage() {
  const { vehicleId } = useParams();
  const auth = useAuth();
  const { tokens } = useTheme();
  const STATE_COLOR = { online: tokens.charge, charging: tokens.charge, driving: tokens.drive };
  const { data, loading, refetch } = useQuery(VEHICLE_OVERVIEW_QUERY, {
    variables: { id: vehicleId },
    fetchPolicy: "cache-and-network",
  });
  const [refreshVehicle, { loading: refreshing, error: refreshError }] = useMutation(REFRESH_VEHICLE_MUTATION, {
    variables: { id: vehicleId },
    onCompleted: () => refetch(),
    onError: () => {}, // swallow here so it surfaces via `error` below instead of an unhandled rejection
  });

  if (loading && !data) return <Loader />;
  const vehicle = data?.vehicle;
  const snap = vehicle?.latestSnapshot;
  // vehicleStateTs is older than ts when odometer/locked/GPS were carried forward
  // from an earlier reading (e.g. Tesla omits that data while the car's main
  // computer sleeps mid-charge) rather than coming from this snapshot fresh.
  const vehicleStateStale = snap?.vehicleStateTs && snap.vehicleStateTs !== snap.ts;
  const vehicleStateCaption = vehicleStateStale
    ? `as of ${new Date(snap.vehicleStateTs).toLocaleString()}`
    : null;

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={2} mb={2}>
        <Typography variant="h5">{vehicle?.displayName || vehicle?.vin}</Typography>
        {snap?.state && (
          <Chip
            label={snap.state}
            size="small"
            variant="outlined"
            sx={{
              fontFamily: monoFont,
              textTransform: "uppercase",
              fontSize: "0.7rem",
              borderColor: STATE_COLOR[snap.state] || "divider",
              color: STATE_COLOR[snap.state] || "text.secondary",
            }}
          />
        )}
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
              <Stat
                label="Battery"
                value={snap.batteryLevel != null ? `${snap.batteryLevel}%` : "—"}
                rail={snap.batteryLevel != null && <ChargeRail value={snap.batteryLevel} />}
              />
            </Grid>
            <Grid item xs={6} sm={3}>
              <Stat label="Range" value={snap.batteryRange != null ? `${Math.round(snap.batteryRange)} km` : "—"} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <Stat
                label="Odometer"
                value={snap.odometer != null ? `${Math.round(snap.odometer)} km` : "—"}
                caption={vehicleStateCaption}
              />
            </Grid>
            <Grid item xs={6} sm={3}>
              <Stat
                label="Locked"
                value={snap.locked != null ? (snap.locked ? "Yes" : "No") : "—"}
                caption={vehicleStateCaption}
              />
            </Grid>
          </Grid>
          {snap.lat != null && snap.lng != null && (
            <Box
              sx={{
                height: { xs: "45vh", sm: "60vh" },
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                overflow: "hidden",
              }}
            >
              <Map center={[snap.lat, snap.lng]} height="100%">
                <Marker position={[snap.lat, snap.lng]}>
                  <Popup>Last seen {new Date(snap.ts).toLocaleString()}</Popup>
                </Marker>
              </Map>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
