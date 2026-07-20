import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Select, MenuItem } from "@mui/material";
import { sectionFromPath } from "../utils/section.js";

export function VehicleSelector({ vehicles }) {
  const { vehicleId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  function handleChange(e) {
    navigate(`/v/${e.target.value}/${sectionFromPath(location.pathname)}`);
  }

  return (
    <Select size="small" value={vehicleId || ""} onChange={handleChange} sx={{ minWidth: 180 }}>
      {vehicles.map((v) => (
        <MenuItem key={v.id} value={v.id}>
          {v.displayName || v.vin}
        </MenuItem>
      ))}
    </Select>
  );
}
