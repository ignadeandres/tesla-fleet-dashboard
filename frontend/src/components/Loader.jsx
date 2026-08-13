import { Box, keyframes } from "@mui/material";
import { tokens } from "../theme/index.js";

const sweep = keyframes`
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
`;

// App-wide loading indicator: a charge-rail track with a moving fill, standing in
// for MUI's default CircularProgress everywhere the app shows a "loading" state.
export function Loader() {
  return (
    <Box
      sx={{
        width: 120,
        height: 8,
        borderRadius: "1px",
        backgroundColor: tokens.line,
        overflow: "hidden",
        my: 4,
      }}
    >
      <Box
        sx={{
          width: "25%",
          height: "100%",
          backgroundColor: tokens.charge,
          animation: `${sweep} 1.1s ease-in-out infinite`,
        }}
      />
    </Box>
  );
}
