import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ApolloProvider } from "@apollo/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import "leaflet/dist/leaflet.css";
import { apolloClient } from "./graphql/client.js";
import { getTheme } from "./theme/index.js";
import { ModeProvider, useColorMode } from "./theme/ModeContext.jsx";
import { AuthProvider } from "./auth/AuthContext.jsx";
import { App } from "./App.jsx";

function Root() {
  const { mode } = useColorMode();
  const theme = useMemo(() => getTheme(mode), [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ApolloProvider client={apolloClient}>
      <ModeProvider>
        <Root />
      </ModeProvider>
    </ApolloProvider>
  </React.StrictMode>
);
