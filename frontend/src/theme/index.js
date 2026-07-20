import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#e82127" },
    background: { default: "#121212", paper: "#1a1a1a" },
  },
  shape: { borderRadius: 8 },
});
