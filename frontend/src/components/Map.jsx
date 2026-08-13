import { MapContainer, TileLayer } from "react-leaflet";
import { useTheme } from "@mui/material";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Vite doesn't resolve Leaflet's default marker image paths from CSS — point them at
// the bundled assets instead, once, for every map on the page.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// height accepts any CSS size ("60vh", "100%", a number of px) so callers can
// let the map fill available space instead of a small fixed box.
export function Map({ center, zoom = 15, height = "60vh", children }) {
  const { palette } = useTheme();
  // CartoDB dark/light basemaps — a fixed dark tile source would clash with light
  // mode the same way the original bright OSM tiles clashed with dark mode.
  const tileUrl =
    palette.mode === "light"
      ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

  return (
    <MapContainer center={center} zoom={zoom} style={{ height, width: "100%" }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url={tileUrl}
      />
      {children}
    </MapContainer>
  );
}
