import { Outlet, useParams, Link as RouterLink, useLocation } from "react-router-dom";
import { AppBar, Toolbar, Typography, Tabs, Tab, Box, Button, Chip } from "@mui/material";
import { useAuth } from "../auth/AuthContext.jsx";
import { VehicleSelector } from "./VehicleSelector.jsx";
import { sectionFromPath } from "../utils/section.js";

const SECTIONS = [
  ["overview", "Overview"],
  ["trips", "Trips"],
  ["charging", "Charging"],
  ["trends", "Trends"],
  ["statelog", "State Log"],
];

export function Layout() {
  const auth = useAuth();
  const { vehicleId } = useParams();
  const location = useLocation();
  const section = sectionFromPath(location.pathname);
  const vehicles = auth.user?.vehicles || [];

  return (
    <Box>
      <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 0 }}>
            Tesla Fleet Dashboard
          </Typography>
          {auth.user?.isDemo && <Chip label="Demo Mode" color="primary" size="small" />}
          {vehicles.length > 0 && <VehicleSelector vehicles={vehicles} />}
          <Box sx={{ flexGrow: 1 }} />
          {!auth.user?.isDemo && (
            <Button component="a" href="/auth/tesla/login" size="small">
              Link Tesla Account
            </Button>
          )}
          <Button size="small" onClick={() => auth.logout()}>
            Log out
          </Button>
        </Toolbar>
        {vehicleId && (
          <Tabs value={section} sx={{ px: 2 }}>
            {SECTIONS.map(([key, label]) => (
              <Tab
                key={key}
                value={key}
                label={label}
                component={RouterLink}
                to={`/v/${vehicleId}/${key}`}
              />
            ))}
          </Tabs>
        )}
      </AppBar>
      <Box p={3}>
        <Outlet />
      </Box>
    </Box>
  );
}
