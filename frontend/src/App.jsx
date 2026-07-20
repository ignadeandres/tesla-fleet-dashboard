import { Routes, Route, Navigate } from "react-router-dom";
import { Box, CircularProgress } from "@mui/material";
import { useAuth } from "./auth/AuthContext.jsx";
import { LoginPage } from "./auth/LoginPage.jsx";
import { Layout } from "./components/Layout.jsx";
import { VehiclesPage } from "./pages/VehiclesPage.jsx";
import { OverviewPage } from "./pages/OverviewPage.jsx";
import { TripsPage } from "./pages/TripsPage.jsx";
import { ChargingPage } from "./pages/ChargingPage.jsx";
import { TrendsPage } from "./pages/TrendsPage.jsx";
import { StateLogPage } from "./pages/StateLogPage.jsx";

function HomeRedirect() {
  const auth = useAuth();
  const first = auth.user?.vehicles?.[0];
  return <Navigate to={first ? `/v/${first.id}/overview` : "/vehicles"} replace />;
}

export function App() {
  const auth = useAuth();

  if (auth.loading) {
    return (
      <Box display="flex" justifyContent="center" mt={10}>
        <CircularProgress />
      </Box>
    );
  }

  if (!auth.user) {
    return (
      <Routes>
        <Route path="/register" element={<LoginPage register />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/vehicles" element={<VehiclesPage />} />
        <Route path="/v/:vehicleId/overview" element={<OverviewPage />} />
        <Route path="/v/:vehicleId/trips" element={<TripsPage />} />
        <Route path="/v/:vehicleId/charging" element={<ChargingPage />} />
        <Route path="/v/:vehicleId/trends" element={<TrendsPage />} />
        <Route path="/v/:vehicleId/statelog" element={<StateLogPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
