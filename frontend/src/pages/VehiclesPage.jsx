import { useSearchParams, Link as RouterLink } from "react-router-dom";
import { Box, Typography, Button, Alert, List, ListItemButton, ListItemText } from "@mui/material";
import { useAuth } from "../auth/AuthContext.jsx";

export function VehiclesPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const vehicles = auth.user?.vehicles || [];

  return (
    <Box maxWidth={480}>
      <Typography variant="h5" mb={2}>
        Your vehicles
      </Typography>
      {params.get("linked") && <Alert severity="success" sx={{ mb: 2 }}>Vehicle linked.</Alert>}
      {params.get("linkError") && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Linking failed ({params.get("linkError")}). Try again.
        </Alert>
      )}
      {vehicles.length === 0 && <Typography mb={2}>No vehicles linked yet.</Typography>}
      <List>
        {vehicles.map((v) => (
          <ListItemButton key={v.id} component={RouterLink} to={`/v/${v.id}/overview`}>
            <ListItemText primary={v.displayName || v.vin} secondary={v.model} />
          </ListItemButton>
        ))}
      </List>
      {!auth.user?.isDemo && (
        <Button variant="contained" component="a" href="/auth/tesla/login" sx={{ mt: 2 }}>
          Link Tesla Account
        </Button>
      )}
    </Box>
  );
}
