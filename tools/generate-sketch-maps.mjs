// One-off generator for the pencil-sketch scene map pool.
// Run with: node tools/generate-sketch-maps.mjs
// Produces foundry-module/assets/atlas/sketch-maps/sketch-map-0N.svg
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "foundry-module", "assets", "atlas", "sketch-maps");

function mulberry32(seed) {
  let t = seed;
  return function rand() {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function jitteredPolygon(rand, cx, cy, radius, points, jitter) {
  const coords = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r = radius * (1 - jitter / 2 + rand() * jitter);
    coords.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.62]);
  }
  return coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ");
}

function riverPath(rand, startX, startY, segments, dx, dy) {
  let x = startX;
  let y = startY;
  const points = [`${x.toFixed(1)},${y.toFixed(1)}`];
  for (let i = 0; i < segments; i++) {
    x += dx + (rand() - 0.5) * 90;
    y += dy + (rand() - 0.5) * 70;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points;
}

function smoothPath(points) {
  if (points.length < 3) return `M ${points.join(" L ")}`;
  let d = `M ${points[0]}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]}`;
  return d;
}

function mountainRange(rand, baseX, baseY, count, spread, height) {
  let d = "";
  for (let i = 0; i < count; i++) {
    const x = baseX + i * spread + (rand() - 0.5) * 20;
    const peak = height * (0.6 + rand() * 0.5);
    d += `M ${(x - spread * 0.45).toFixed(1)} ${baseY} L ${x.toFixed(1)} ${(baseY - peak).toFixed(1)} L ${(x + spread * 0.45).toFixed(1)} ${baseY} `;
  }
  return d;
}

function forestClump(rand, cx, cy, count, spread) {
  let marks = "";
  for (let i = 0; i < count; i++) {
    const x = cx + (rand() - 0.5) * spread;
    const y = cy + (rand() - 0.5) * spread * 0.6;
    const size = 9 + rand() * 8;
    marks += `<path d="M ${x.toFixed(1)} ${(y + size).toFixed(1)} L ${x.toFixed(1)} ${(y - size).toFixed(1)} M ${(x - size * 0.6).toFixed(1)} ${(y - size * 0.15).toFixed(1)} L ${x.toFixed(1)} ${(y - size).toFixed(1)} L ${(x + size * 0.6).toFixed(1)} ${(y - size * 0.15).toFixed(1)}" />`;
  }
  return marks;
}

const themes = [
  { title: "Unnamed Coast, First Draft", labels: ["Windward Shoals", "The Grey Downs", "Kettle Fen", "Old Signal Rock"] },
  { title: "Surveyor's Sketch No. 7", labels: ["Hollow Vale", "Rooktooth Ridge", "Ashmere Crossing", "The Split Road"] },
  { title: "Provisional Border Chart", labels: ["Wickerfall", "Salt Anvil Flats", "Bramblewatch", "Dunecarver Pass"] },
  { title: "Cartographer's Working Copy", labels: ["Emberline Hills", "The Quiet Marsh", "Foxglove Landing", "Cairn's End"] },
  { title: "Field Map, Unverified", labels: ["Thistledown", "Grimwater Bend", "Copperspine Ridge", "The Long Silt"] }
];

for (let index = 0; index < 5; index++) {
  const seed = 90210 + index * 733;
  const rand = mulberry32(seed);
  const theme = themes[index];

  const coastPoints = jitteredPolygon(rand, 1024 + (rand() - 0.5) * 120, 620 + (rand() - 0.5) * 80, 470 + rand() * 90, 13, 0.4);
  const island = jitteredPolygon(rand, 1650 + rand() * 120, 260 + rand() * 90, 110 + rand() * 40, 9, 0.5);
  const river = smoothPath(riverPath(rand, 260 + rand() * 120, 140, 11, 68, 88));
  const river2 = smoothPath(riverPath(rand, 1780 - rand() * 100, 1000, 9, -64, -74));
  const mountains = mountainRange(rand, 120 + rand() * 60, 300 + rand() * 60, 6, 95, 150 + rand() * 60);
  const mountains2 = mountainRange(rand, 1350 + rand() * 40, 980 + rand() * 30, 5, 88, 130 + rand() * 50);
  const forestA = forestClump(rand, 620 + rand() * 100, 780 + rand() * 80, 14, 340);
  const forestB = forestClump(rand, 1420 + rand() * 100, 420 + rand() * 80, 10, 260);
  const roadPoints = riverPath(rand, 210, 980, 10, 165, -70).join(" L ");
  const grid = rand() > 0.5;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 1152" role="img" aria-labelledby="title-${index} desc-${index}">
  <title id="title-${index}">${theme.title}</title>
  <desc id="desc-${index}">A large hand-drawn pencil-sketch placeholder map for a Game Master to relabel and repurpose.</desc>
  <defs>
    <filter id="pencil-${index}" x="-8%" y="-8%" width="116%" height="116%">
      <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="${seed % 97}" result="grain"/>
      <feDisplacementMap in="SourceGraphic" in2="grain" scale="9" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="paper-grain-${index}" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${(seed + 11) % 89}" result="fiber"/>
      <feColorMatrix in="fiber" type="matrix" values="0 0 0 0 0.1  0 0 0 0 0.08  0 0 0 0 0.05  0 0 0 0.05 0"/>
    </filter>
    <pattern id="hatch-${index}" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(${35 + index * 9})">
      <path d="M0 0 L0 14" stroke="#3a332a" stroke-width="1" opacity="0.28"/>
    </pattern>
    <pattern id="crosshatch-${index}" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(${-25 + index * 6})">
      <path d="M0 0 L16 16 M16 0 L0 16" stroke="#2c261e" stroke-width="1" opacity="0.22"/>
    </pattern>
  </defs>
  <rect width="2048" height="1152" fill="#ece1c6"/>
  <rect width="2048" height="1152" filter="url(#paper-grain-${index})" opacity="0.5"/>
  <rect x="10" y="10" width="2028" height="1132" fill="none" stroke="#4a3f2e" stroke-width="6" stroke-dasharray="2 10" opacity="0.55"/>
  <g filter="url(#pencil-${index})" fill="none" stroke="#2c2416" stroke-width="5" stroke-linejoin="round">
    <path d="M ${coastPoints} Z" fill="#ded0a4" fill-opacity="0.9"/>
    <path d="M ${coastPoints} Z" fill="url(#hatch-${index})"/>
    <path d="M ${island} Z" fill="#dccf9f" stroke-width="4"/>
    <path d="${mountains}" stroke-width="4.5" fill="url(#crosshatch-${index})" stroke="#241f16"/>
    <path d="${mountains2}" stroke-width="4.5" fill="url(#crosshatch-${index})" stroke="#241f16"/>
    <path d="${river}" stroke="#3c5a63" stroke-width="6" opacity="0.8"/>
    <path d="${river2}" stroke="#3c5a63" stroke-width="5" opacity="0.75"/>
    <path d="M ${roadPoints}" stroke="#5b4a30" stroke-width="4" stroke-dasharray="14 12" opacity="0.85"/>
    ${forestA}
    ${forestB}
  </g>
  ${grid ? `<rect width="2048" height="1152" fill="none" stroke="#4a3f2e" stroke-width="1" opacity="0.06"/>` : ""}
  <g filter="url(#pencil-${index})" fill="none" stroke="#241f16" stroke-width="2.5" opacity="0.8">
    <circle cx="1780" cy="150" r="70"/>
    <path d="M1780 80 L1780 220 M1710 150 L1850 150 M1732 102 L1828 198 M1828 102 L1732 198"/>
  </g>
  <g font-family="Georgia, serif" fill="#2b2416" text-anchor="middle" opacity="0.92">
    <text x="1024" y="90" font-size="46" letter-spacing="6" font-style="italic">${theme.title}</text>
    <text x="1024" y="1090" font-size="20" font-style="italic">Unlabeled placeholder sketch - relabel freely for your table.</text>
    <text x="${(620 + rand() * 60).toFixed(0)}" y="${(700 + rand() * 40).toFixed(0)}" font-size="30">${theme.labels[0]}</text>
    <text x="${(280 + rand() * 60).toFixed(0)}" y="${(300 + rand() * 40).toFixed(0)}" font-size="28">${theme.labels[1]}</text>
    <text x="${(1500 + rand() * 60).toFixed(0)}" y="${(480 + rand() * 40).toFixed(0)}" font-size="28">${theme.labels[2]}</text>
    <text x="${(1100 + rand() * 60).toFixed(0)}" y="${(950 + rand() * 40).toFixed(0)}" font-size="28">${theme.labels[3]}</text>
  </g>
</svg>
`;

  const fileName = `sketch-map-${String(index + 1).padStart(2, "0")}.svg`;
  writeFileSync(path.join(outDir, fileName), svg, "utf8");
  console.log(`Wrote ${fileName}`);
}
