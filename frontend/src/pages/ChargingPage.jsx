import { useParams } from "react-router-dom";
import { useQuery } from "@apollo/client";
import { Box, List, ListItem, Typography } from "@mui/material";
import { VEHICLE_CHARGING_QUERY } from "../graphql/queries/charging.js";
import { ChargeRail } from "../components/ChargeRail.jsx";
import { Loader } from "../components/Loader.jsx";
import { monoFont } from "../theme/index.js";

export function ChargingPage() {
  const { vehicleId } = useParams();
  const { data, loading } = useQuery(VEHICLE_CHARGING_QUERY, {
    variables: { id: vehicleId, limit: 50 },
    fetchPolicy: "cache-and-network",
  });

  if (loading && !data) return <Loader />;
  const sessions = data?.vehicle?.chargingSessions || [];

  if (sessions.length === 0) return <Typography color="text.secondary">No charging sessions recorded yet.</Typography>;

  return (
    <List sx={{ maxWidth: 640 }}>
      {sessions.map((s) => {
        const inProgress = s.endTime == null;
        return (
          <ListItem key={s.id} sx={{ display: "block", borderBottom: 1, borderColor: "divider", py: 1.5, px: 0 }}>
            <Box display="flex" justifyContent="space-between" alignItems="baseline" mb={0.75}>
              <Typography variant="body2">{new Date(s.startTime).toLocaleString()}</Typography>
              <Typography variant="caption" color="text.secondary">
                {inProgress
                  ? "charging…"
                  : `${Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000)} min`}
              </Typography>
            </Box>
            <ChargeRail value={s.endBatteryLevel ?? s.startBatteryLevel} from={s.startBatteryLevel} />
            <Box display="flex" justifyContent="space-between" alignItems="baseline" mt={0.75}>
              <Typography variant="caption" sx={{ fontFamily: monoFont }} color="text.secondary">
                {s.startBatteryLevel}% → {s.endBatteryLevel ?? "—"}%
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: monoFont }} color="text.secondary">
                {s.energyAddedKwh != null ? `${s.energyAddedKwh.toFixed(1)} kWh` : "—"}
              </Typography>
            </Box>
          </ListItem>
        );
      })}
    </List>
  );
}
