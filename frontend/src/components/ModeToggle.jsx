import { IconButton } from "@mui/material";
import { useColorMode } from "../theme/ModeContext.jsx";

// No icon package is installed — one sun/moon pair doesn't warrant adding
// @mui/icons-material, so these are hand-rolled like the state-log icons.
function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8l1.8-1.8M18 6l1.8-1.8" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Shows the icon for the mode a click switches TO, not the current mode.
export function ModeToggle() {
  const { mode, toggleMode } = useColorMode();
  return (
    <IconButton size="small" onClick={toggleMode} aria-label="Toggle light/dark mode" sx={{ color: "text.secondary" }}>
      {mode === "dark" ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
}
