import { createTheme } from "@mui/material/styles";

// "Ink & cobalt" identity: navy/ink dark mode, cool-white light mode, one blue
// accent family (cobalt for charge/primary, a lighter sky blue for drive/secondary)
// instead of the earlier black/green look. See docs/dashboard-overview.md.
export const monoFont = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';

const darkTokens = {
  bg: "#0B0F17",
  surface: "#131A24",
  surfaceRaised: "#1B2432",
  line: "#232C3B",
  text: "#E7ECF3",
  textMuted: "#8D98AC",
  charge: "#4C8DFF",
  drive: "#38BDF8",
  alert: "#F5A623",
  error: "#FF6B6B",
};

const lightTokens = {
  bg: "#F5F7FA",
  surface: "#FFFFFF",
  surfaceRaised: "#EEF1F5",
  line: "#DDE3EA",
  text: "#1A2230",
  textMuted: "#5B6472",
  charge: "#2F6FED",
  drive: "#0EA5E9",
  alert: "#C9791A",
  error: "#D93025",
};

// Returns a fresh MUI theme for the given mode, with the raw color tokens
// attached at `theme.tokens` for components that need a specific token (charge
// rail fill, chart colors, map tiles) rather than a generic MUI palette slot.
export function getTheme(mode) {
  const tokens = mode === "light" ? lightTokens : darkTokens;

  const theme = createTheme({
    palette: {
      mode,
      primary: { main: tokens.charge, contrastText: "#FFFFFF" },
      secondary: { main: tokens.drive, contrastText: "#FFFFFF" },
      warning: { main: tokens.alert },
      error: { main: tokens.error },
      success: { main: tokens.charge, contrastText: "#FFFFFF" },
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

  theme.tokens = tokens;
  return theme;
}
