import { useParams } from "react-router-dom";
import { useQuery } from "@apollo/client";
import { Box, Typography, useTheme } from "@mui/material";
import { VEHICLE_STATE_LOG_QUERY } from "../graphql/queries/stateLog.js";
import { Loader } from "../components/Loader.jsx";
import { monoFont } from "../theme/index.js";

// Minimal hand-drawn icons — no icon package is installed and one glyph each
// doesn't warrant adding @mui/icons-material for it.
function LockIcon({ locked }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d={locked ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7-2.5"} />
    </svg>
  );
}

function ClimateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v18M4.5 6.5l15 11M19.5 6.5l-15 11" />
    </svg>
  );
}

function groupByDay(log) {
  const groups = [];
  for (const row of log) {
    const day = new Date(row.ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) {
      group = { day, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

export function StateLogPage() {
  const { vehicleId } = useParams();
  const { tokens } = useTheme();
  const { data, loading } = useQuery(VEHICLE_STATE_LOG_QUERY, {
    variables: { id: vehicleId },
    fetchPolicy: "cache-and-network",
  });

  if (loading && !data) return <Loader />;
  const log = data?.vehicle?.stateLog || [];

  if (log.length === 0) return <Typography color="text.secondary">No history yet.</Typography>;

  return (
    <Box sx={{ maxWidth: 720 }}>
      {groupByDay(log).map((group) => (
        <Box key={group.day} mb={2}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: "0.05em", display: "block", mb: 1 }}
          >
            {group.day}
          </Typography>
          {group.rows.map((s) => (
            <Box
              key={s.ts}
              display="flex"
              alignItems="center"
              gap={2}
              sx={{ borderBottom: 1, borderColor: "divider", py: 1 }}
            >
              <Typography sx={{ fontFamily: monoFont, fontSize: "0.8rem", width: 76, flexShrink: 0 }} color="text.secondary">
                {new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </Typography>
              <Typography sx={{ fontSize: "0.85rem", width: 90, flexShrink: 0 }}>{s.state}</Typography>
              <Box display="flex" alignItems="center" gap={0.5} sx={{ color: s.locked ? tokens.charge : "text.secondary", width: 90 }}>
                <LockIcon locked={s.locked} />
                <Typography variant="caption">{s.locked == null ? "—" : s.locked ? "Locked" : "Unlocked"}</Typography>
              </Box>
              <Box display="flex" alignItems="center" gap={0.5} sx={{ color: s.climateOn ? tokens.drive : "text.secondary", width: 70 }}>
                <ClimateIcon />
                <Typography variant="caption">{s.climateOn == null ? "—" : s.climateOn ? "On" : "Off"}</Typography>
              </Box>
              <Typography variant="caption" sx={{ fontFamily: monoFont }} color="text.secondary">
                {s.insideTemp != null ? `${Math.round(s.insideTemp)}°` : "—"} / {s.outsideTemp != null ? `${Math.round(s.outsideTemp)}°` : "—"}
              </Typography>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
