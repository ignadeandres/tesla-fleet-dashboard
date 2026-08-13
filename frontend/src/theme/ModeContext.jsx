import { createContext, useContext, useEffect, useState } from "react";

const ModeContext = createContext(null);
const STORAGE_KEY = "tesla-fleet-dashboard:theme-mode";

function initialMode() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ModeProvider({ children }) {
  const [mode, setMode] = useState(initialMode);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  function toggleMode() {
    setMode((m) => (m === "dark" ? "light" : "dark"));
  }

  return <ModeContext.Provider value={{ mode, toggleMode }}>{children}</ModeContext.Provider>;
}

export function useColorMode() {
  return useContext(ModeContext);
}
