import { useParams } from "react-router-dom";
import { useQuery } from "@apollo/client";
import { Table, TableHead, TableBody, TableRow, TableCell, Typography, CircularProgress } from "@mui/material";
import { VEHICLE_STATE_LOG_QUERY } from "../graphql/queries/stateLog.js";

export function StateLogPage() {
  const { vehicleId } = useParams();
  const { data, loading } = useQuery(VEHICLE_STATE_LOG_QUERY, { variables: { id: vehicleId } });

  if (loading && !data) return <CircularProgress />;
  const log = data?.vehicle?.stateLog || [];

  if (log.length === 0) return <Typography color="text.secondary">No history yet.</Typography>;

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Time</TableCell>
          <TableCell>State</TableCell>
          <TableCell>Locked</TableCell>
          <TableCell>Climate</TableCell>
          <TableCell>Inside / Outside</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {log.map((s) => (
          <TableRow key={s.ts}>
            <TableCell>{new Date(s.ts).toLocaleString()}</TableCell>
            <TableCell>{s.state}</TableCell>
            <TableCell>{s.locked == null ? "—" : s.locked ? "Locked" : "Unlocked"}</TableCell>
            <TableCell>{s.climateOn == null ? "—" : s.climateOn ? "On" : "Off"}</TableCell>
            <TableCell>
              {s.insideTemp != null ? `${Math.round(s.insideTemp)}°` : "—"} /{" "}
              {s.outsideTemp != null ? `${Math.round(s.outsideTemp)}°` : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
