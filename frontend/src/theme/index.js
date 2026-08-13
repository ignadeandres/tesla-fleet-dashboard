import { createTheme } from "@mui/material/styles";

// "Instrument panel" identity: graphite surfaces + hairline borders instead of
// MUI's default shadow elevation, lime for charge/energy, blue for drive/distance,
// amber for alerts. See docs/dashboard-overview.md for the rationale.
export const tokens = {
  bg: "#0B0E11",
  surface: "#14181D",
  surfaceRaised: "#1C2127",
  line: "#262C33",
  text: "#E8ECEF",
  textMuted: "#8B95A1",
  charge: "#A8FF60",
  drive: "#5EC8FF",
  alert: "#FFB84D",
  error: "#FF5C5C",
};

// Numeric readouts (battery %, km, kWh, timestamps) use mono type so stat tiles
// read as instrumentation rather than prose.
export const monoFont = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: tokens.charge, contrastText: "#0B0E11" },
    secondary: { main: tokens.drive, contrastText: "#0B0E11" },
    warning: { main: tokens.alert },
    error: { main: tokens.error },
    success: { main: tokens.charge, contrastText: "#0B0E11" },
    background: { default: tokens.bg, paper: tokens.surface },
    text: { primary: tokens.text, secondary: tokens.textMuted },
    divider: tokens.line,
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
    button: { textTransform: "none", fontWeight: 600 },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          border: `1px solid ${tokens.line}`,
          boxShadow: "none",
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: { backgroundImage: "none", boxShadow: "none" },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderColor: tokens.line },
        head: { color: tokens.textMuted, fontSize: "0.75rem", letterSpacing: "0.02em" },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 4 },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: { height: 2 },
      },
    },
  },
});
