export default function Radar({ axes }: { axes: { label: string; norm: number }[] }) {
  const cx = 150, cy = 150, R = 110;
  const pt = (i: number, r: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  };
  const ring = (f: number) => axes.map((_, i) => pt(i, R * f).join(',')).join(' ');
  const shape = axes.map((a, i) => pt(i, R * Math.max(0.02, a.norm)).join(',')).join(' ');

  return (
    <svg viewBox="0 0 300 300" width={300} height={300} role="img" aria-label="Stats radar">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="#ddd" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#ddd" />;
      })}
      <polygon points={shape} fill="rgba(232,89,12,0.35)" stroke="#e8590c" strokeWidth={2} />
      {axes.map((a, i) => {
        const [x, y] = pt(i, R + 24);
        return (
          <text key={i} x={x} y={y} textAnchor="middle" fontSize={13} fill="#333">
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}
