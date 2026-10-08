// Small illustrations drawn in code (sharp at any size, follow the theme, cost nothing to load).
// They stand in for the images Showrium makes for posts. Decorative: hidden from screen readers.

/** A pizza cut into eighths, one slice pulled out: the teacher's fractions lesson. */
export function PizzaFractions({ className = "" }: { className?: string }) {
  const slices = Array.from({ length: 8 }, (_, i) => i);
  const r = 70;
  const path = (i: number) => {
    const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 2;
    return `M0 0 L${(r * Math.cos(a0)).toFixed(1)} ${(r * Math.sin(a0)).toFixed(1)} A${r} ${r} 0 0 1 ${(r * Math.cos(a1)).toFixed(1)} ${(r * Math.sin(a1)).toFixed(1)} Z`;
  };
  return (
    <svg viewBox="-110 -95 220 190" className={className} aria-hidden="true">
      <circle r="84" fill="#F6C76B" opacity="0.25" />
      {slices.map((i) => {
        const mid = ((i + 0.5) / 8) * Math.PI * 2 - Math.PI / 2;
        const out = i === 1 ? 14 : 0;
        return (
          <g key={i} transform={`translate(${(out * Math.cos(mid)).toFixed(1)} ${(out * Math.sin(mid)).toFixed(1)})`} className={i === 1 ? "mk-float" : ""}>
            <path d={path(i)} fill="#F2B35A" stroke="#C7832A" strokeWidth="2" />
            <circle cx={(42 * Math.cos(mid)).toFixed(1)} cy={(42 * Math.sin(mid)).toFixed(1)} r="7" fill="#C2452D" />
            <circle cx={(24 * Math.cos(mid + 0.25)).toFixed(1)} cy={(24 * Math.sin(mid + 0.25)).toFixed(1)} r="4" fill="#5E8C3A" />
          </g>
        );
      })}
      <text x="78" y="-58" fontSize="22" fontWeight="700" fill="currentColor" fontFamily="Bricolage Grotesque, system-ui">1/8</text>
    </svg>
  );
}

/** Error rate falling after the release: the developer's retry change. */
export function ErrorChart({ className = "" }: { className?: string }) {
  const before = [62, 70, 58, 74, 66, 71];
  const after = [34, 28, 22, 19, 16, 14];
  const pts = [...before, ...after].map((v, i) => `${10 + i * 17},${90 - v}`).join(" ");
  return (
    <svg viewBox="0 0 220 110" className={className} aria-hidden="true">
      <line x1="10" y1="92" x2="210" y2="92" stroke="currentColor" opacity="0.2" />
      <line x1="104" y1="10" x2="104" y2="92" stroke="#E3A443" strokeDasharray="4 4" />
      <text x="108" y="20" fontSize="10" fill="#E3A443" fontFamily="IBM Plex Mono, monospace">v1.4 shipped</text>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" className="mk-draw" pathLength={1} />
      <text x="12" y="106" fontSize="9" fill="currentColor" opacity="0.6" fontFamily="IBM Plex Mono, monospace">errors during outages</text>
    </svg>
  );
}

/** Pricing for Nigeria: coins and a naira sign, for the founder's article. */
export function PricingCoins({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 120" className={className} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <ellipse key={i} cx="70" cy={92 - i * 12} rx="34" ry="10" fill={i % 2 ? "#F2B35A" : "#E3A443"} stroke="#B9782A" strokeWidth="2" />
      ))}
      {[0, 1].map((i) => (
        <ellipse key={i} cx="140" cy={92 - i * 12} rx="34" ry="10" fill={i % 2 ? "#F2B35A" : "#E3A443"} stroke="#B9782A" strokeWidth="2" />
      ))}
      <text x="128" y="50" fontSize="34" fontWeight="700" fill="currentColor" fontFamily="Bricolage Grotesque, system-ui" className="mk-float">₦</text>
    </svg>
  );
}
