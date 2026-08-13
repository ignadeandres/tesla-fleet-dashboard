import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useTheme } from "@mui/material";
import { monoFont } from "../../theme/index.js";

export function BatteryTrendChart({ data }) {
  const { tokens } = useTheme();
  const points = data.map((d) => ({ ...d, tsLabel: new Date(d.ts).toLocaleDateString() }));
  const tick = { fill: tokens.textMuted, fontFamily: monoFont, fontSize: 11 };

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={points}>
        <defs>
          <linearGradient id="chargeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tokens.charge} stopOpacity={0.35} />
            <stop offset="100%" stopColor={tokens.charge} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={tokens.line} vertical={false} />
        <XAxis dataKey="tsLabel" minTickGap={40} tick={tick} axisLine={{ stroke: tokens.line }} tickLine={false} />
        <YAxis domain={[0, 100]} unit="%" tick={tick} axisLine={false} tickLine={false} width={44} />
        <Tooltip
          labelFormatter={(_, p) => (p[0] ? new Date(p[0].payload.ts).toLocaleString() : "")}
          contentStyle={{ background: tokens.surfaceRaised, border: `1px solid ${tokens.line}`, borderRadius: 6 }}
          labelStyle={{ color: tokens.text }}
          itemStyle={{ color: tokens.charge, fontFamily: monoFont }}
        />
        <Area
          type="monotone"
          dataKey="batteryLevel"
          stroke={tokens.charge}
          strokeWidth={2}
          fill="url(#chargeFill)"
          dot={false}
          name="Battery %"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
