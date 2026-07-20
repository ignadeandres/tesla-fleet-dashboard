import { useParams } from "react-router-dom";
import { useQuery } from "@apollo/client";
import { Typography, CircularProgress, Paper } from "@mui/material";
import { VEHICLE_STATE_LOG_QUERY } from "../graphql/queries/stateLog.js";
import { BatteryTrendChart } from "../components/charts/BatteryTrendChart.jsx";

export function TrendsPage() {
  const { vehicleId } = useParams();
  const { data, loading } = useQuery(VEHICLE_STATE_LOG_QUERY, { variables: { id: vehicleId } });

  if (loading && !data) return <CircularProgress />;
  const log = data?.vehicle?.stateLog || [];

  if (log.length === 0) return <Typography color="text.secondary">No history yet.</Typography>;

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" mb={2}>
        Battery level over time
      </Typography>
      <BatteryTrendChart data={[...log].reverse()} />
    </Paper>
  );
}
