import { Box, useTheme } from "@mui/material";

const SEGMENTS = 20;

// Segmented battery-style gauge — the app's one signature visual element, reused
// for the Overview battery tile and each Charging session's start%->end% range.
export function ChargeRail({ value, from, height = 10, color }) {
  const { tokens } = useTheme();
  const fillColor = color || tokens.charge;
  const end = Math.round(Math.max(0, Math.min(100, value ?? 0)) / (100 / SEGMENTS));
  const start = from != null ? Math.round(Math.max(0, Math.min(100, from)) / (100 / SEGMENTS)) : 0;

  return (
    <Box display="flex" gap="2px" height={height}>
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const filled = i < end;
        const inRange = from != null && i >= start && i < end;
        return (
          <Box
            key={i}
            flex={1}
            sx={{
              borderRadius: "1px",
              backgroundColor: filled ? fillColor : tokens.line,
              opacity: filled ? (inRange || from == null ? 1 : 0.4) : 1,
              transition: "background-color 0.2s",
            }}
          />
        );
      })}
    </Box>
  );
}
