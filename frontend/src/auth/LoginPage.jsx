import { useState } from "react";
import { useNavigate, Link as RouterLink } from "react-router-dom";
import { Box, Paper, TextField, Button, Typography, Alert, Link } from "@mui/material";
import { useAuth } from "./AuthContext.jsx";

export function LoginPage({ register = false }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      await (register ? auth.register(email, password) : auth.login(email, password));
      navigate("/");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Box display="flex" justifyContent="center" mt={10}>
      <Paper sx={{ p: 4, width: 360 }} component="form" onSubmit={handleSubmit}>
        <Typography variant="h5" mb={2}>
          {register ? "Create account" : "Log in"}
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <TextField
          label="Email"
          type="email"
          fullWidth
          margin="normal"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextField
          label="Password"
          type="password"
          fullWidth
          margin="normal"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="contained" fullWidth sx={{ mt: 2 }}>
          {register ? "Register" : "Log in"}
        </Button>
        <Typography variant="body2" mt={2}>
          {register ? (
            <Link component={RouterLink} to="/login">
              Already have an account? Log in
            </Link>
          ) : (
            <Link component={RouterLink} to="/register">
              Need an account? Register
            </Link>
          )}
        </Typography>
      </Paper>
    </Box>
  );
}
