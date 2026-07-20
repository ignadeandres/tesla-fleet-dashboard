import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export function BatteryTrendChart({ data }) {
  const points = data.map((d) => ({ ...d, tsLabel: new Date(d.ts).toLocaleDateString() }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={points}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="tsLabel" minTickGap={40} />
        <YAxis domain={[0, 100]} unit="%" />
        <Tooltip labelFormatter={(_, p) => (p[0] ? new Date(p[0].payload.ts).toLocaleString() : "")} />
        <Line type="monotone" dataKey="batteryLevel" stroke="#e82127" dot={false} name="Battery %" />
      </LineChart>
    </ResponsiveContainer>
  );
}
