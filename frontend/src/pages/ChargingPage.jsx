import { useParams } from "react-router-dom";
import { useQuery } from "@apollo/client";
import { Table, TableHead, TableBody, TableRow, TableCell, Typography, CircularProgress } from "@mui/material";
import { VEHICLE_CHARGING_QUERY } from "../graphql/queries/charging.js";

export function ChargingPage() {
  const { vehicleId } = useParams();
  const { data, loading } = useQuery(VEHICLE_CHARGING_QUERY, { variables: { id: vehicleId, limit: 50 } });

  if (loading && !data) return <CircularProgress />;
  const sessions = data?.vehicle?.chargingSessions || [];

  if (sessions.length === 0) return <Typography color="text.secondary">No charging sessions recorded yet.</Typography>;

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Start</TableCell>
          <TableCell>Duration</TableCell>
          <TableCell>Battery</TableCell>
          <TableCell>Energy added</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sessions.map((s) => (
          <TableRow key={s.id}>
            <TableCell>{new Date(s.startTime).toLocaleString()}</TableCell>
            <TableCell>
              {s.endTime
                ? `${Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000)} min`
                : "in progress"}
            </TableCell>
            <TableCell>
              {s.startBatteryLevel}% → {s.endBatteryLevel ?? "—"}%
            </TableCell>
            <TableCell>{s.energyAddedKwh != null ? `${s.energyAddedKwh.toFixed(1)} kWh` : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
