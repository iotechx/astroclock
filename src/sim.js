// src/sim.js
// Module refactor of the original inline script.
// - Uses element pools instead of innerHTML rebuilds
// - Provides a pluggable ephemeris provider (fallback = linear model)
// - Adds per-planet distance controls, label toggles, and presets

const J2000 = new Date('2000-01-01T12:00:00Z').getTime();
// Zodiac signs with their ecliptic longitude boundaries (angle between dividers varies by actual constellation width)
const ZODIAC = [
  { s: '♈', lon: 0 },      // Aries
  { s: '♉', lon: 30 },     // Taurus
  { s: '♊', lon: 60 },     // Gemini
  { s: '♋', lon: 90 },     // Cancer
  { s: '♌', lon: 120 },    // Leo
  { s: '♍', lon: 150 },    // Virgo
  { s: '♎', lon: 180 },    // Libra
  { s: '♏', lon: 210 },    // Scorpio
  { s: '♐', lon: 240 },    // Sagittarius
  { s: '♑', lon: 270 },    // Capricorn
  { s: '♒', lon: 300 },    // Aquarius
  { s: '♓', lon: 330 }     // Pisces
];
const DEFAULT_PLANETS = [
  { id: 'mercury', sym: '☿', col: '#94a3b8', dist: 350, rate: 149472.6, long: 252.2 },
  { id: 'venus', sym: '♀', col: '#fdba74', dist: 700, rate: 58517.8, long: 181.9 },
  { id: 'earth', sym: '⊕', col: '#3b82f6', dist: 1050, rate: 35999.3, long: 100.4 },
  { id: 'mars', sym: '♂', col: '#ef4444', dist: 1400, rate: 19140.3, long: 355.4 },
  { id: 'jupiter', sym: '♃', col: '#a8a29e', dist: 1750, rate: 3034.7, long: 34.4 },
  { id: 'saturn', sym: '♄', col: '#e7e5e4', dist: 2100, rate: 1222.4, long: 49.9 }
];

let PLANETS = JSON.parse(JSON.stringify(DEFAULT_PLANETS));
let state = { days: (Date.now() - J2000) / 86400000, view: 'helio', speed: 0, direction: 1, zoom: 0.25, pos: { x: 0, y: 0 }, panning: false, history: {} };
PLANETS.forEach(p => state.history[p.id] = []); state.history.sun = [];

// UI layer references (created dynamically if missing)
const svgRoot = document.getElementById('svg-root');
function ensureLayer(id, tag = 'g', parent = svgRoot) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    el.id = id;
    parent.appendChild(el);
  }
  return el;
}

// create world first and attach other layers under it so transforms apply correctly
const ui = {};
ui.world = ensureLayer('world', 'g', svgRoot);
// Zodiac is a SIBLING to world (not a child), so it stays fixed on screen
ui.zodiac = ensureLayer('zodiac-layer', 'g', svgRoot);
ui.orbits = ensureLayer('orbits-layer', 'g', ui.world);
ui.trails = ensureLayer('trails-layer', 'g', ui.world);
ui.markers = ensureLayer('markers-layer', 'g', ui.world);
ui.planets = ensureLayer('planets-layer', 'g', ui.world);
ui.sun = ensureLayer('sun-layer', 'g', ui.world);
ui.moonSys = ensureLayer('moon-system-layer', 'g', ui.world);

// Pools
const pool = {
  zodiacLines: [],
  zodiacText: [],
  orbitCircles: {},
  planetGroups: {},
  planetCircles: {},
  planetTexts: {},
  planetTitles: {},
  trailPaths: {},
  moonGroup: null,
  moonElements: {},
  markerTexts: {},
  outerMarkers: {}
};

// marker connector lines and outer ring
pool.markerLines = {};
pool.outerRing = null;

// Cache frequently-used DOM elements to avoid repeated lookups
const DOM = {
  svgRoot,
  viewport: document.getElementById('viewport'),
  chkOrbits: document.getElementById('chk-orbits'),
  chkTrails: document.getElementById('chk-trails'),
  vYear: document.getElementById('v-year'),
  vMonth: document.getElementById('v-month'),
  vDay: document.getElementById('v-day'),
  vHour: document.getElementById('v-hour'),
  vMin: document.getElementById('v-min'),
  vSec: document.getElementById('v-sec'),
  zoomLabel: document.getElementById('zoom-label'),
  statusDot: document.getElementById('status-dot'),
  statusLabel: document.getElementById('status-label'),
  speedTxt: document.getElementById('speed-txt'),
  speedSlider: document.getElementById('speed-slider'),
  btnHelio: document.getElementById('btn-helio'),
  btnGeo: document.getElementById('btn-geo'),
  flowFwd: document.getElementById('flow-fwd'),
  flowRev: document.getElementById('flow-rev'),
  btnSync: document.getElementById('btn-sync'),
  btnReset: document.getElementById('btn-reset'),
  hud: document.getElementById('hud-bg')
};

let ephemerisProvider = null; // optional provider function: async (days) => positions

async function tryAutoProvider() {
  // If a global `Astronomy` (astronomy-engine) is present, wire a simple provider.
  if (window.Astronomy) {
    ephemerisProvider = async (days) => {
      const date = new Date(J2000 + days * 86400000);
      const pos = { sun: { x: 0, y: 0 } };
      // Map simple list: Astronomy.Equator ecliptic isn't guaranteed; do best-effort using Astronomy.Equator/Vector if available.
      try {
        for (const p of PLANETS) {
          const body = p.id === 'earth' ? 'Earth' : p.id.charAt(0).toUpperCase() + p.id.slice(1);
          const vec = window.Astronomy.Ecliptic(body, date);
          // BodyVector returns { x,y,z } in AU; convert to pixels using a scale factor based on Earth's dist (~1 AU -> earth.dist)
          const scale = PLANETS.find(pl => pl.id === 'earth')?.dist || 1000;
          pos[p.id] = { x: vec.x * scale, y: vec.y * scale };
        }
        pos.moonAbsAng = (days * (360 / 27.321)) * Math.PI / 180;
        pos.nodeAbsAng = (-days * (360 / 6793.5)) * Math.PI / 180;
      } catch (err) {
        // if provider call fails, fallback to linear provider
        ephemerisProvider = null;
        return linearProvider(days);
      }
      return pos;
    };
  }
}

function linearProvider(days) {
  const T = days / 36525.0;
  const res = { sun: { x: 0, y: 0 } };
  PLANETS.forEach(p => {
    const a = ((p.long + p.rate * T) % 360) * Math.PI / 180;
    res[p.id] = { x: p.dist * Math.cos(a), y: p.dist * Math.sin(a) };
  });

  // outer markers layer: create a text element for each planet and additional markers
  res.moonAbsAng = (days * (360 / 27.321)) * Math.PI / 180;
  res.nodeAbsAng = (-days * (360 / 6793.5)) * Math.PI / 180;
  return res;
}

function getPositions(days) {
  if (ephemerisProvider) return ephemerisProvider(days);
  return Promise.resolve(linearProvider(days));
}

// Create and cache DOM elements
function initPools() {
  // Zodiac
  while (ui.zodiac.firstChild) ui.zodiac.removeChild(ui.zodiac.firstChild);
  ZODIAC.forEach((z, i) => {
    const a = (i * 30 - 90);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0); line.setAttribute('y1', 0);
    ui.zodiac.appendChild(line);
    pool.zodiacLines.push(line);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    ui.zodiac.appendChild(text);
    pool.zodiacText.push(text);
  });

  // Orbits and planets
  while (ui.orbits.firstChild) ui.orbits.removeChild(ui.orbits.firstChild);
  while (ui.planets.firstChild) ui.planets.removeChild(ui.planets.firstChild);
  while (ui.trails.firstChild) ui.trails.removeChild(ui.trails.firstChild);
  PLANETS.forEach(p => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('fill', 'none');
    ui.orbits.appendChild(c);
    pool.orbitCircles[p.id] = c;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ui.planets.appendChild(g);
    pool.planetGroups[p.id] = g;

    const pc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pc.setAttribute('r', 8);
    pc.setAttribute('stroke', 'white');
    g.appendChild(pc);
    pool.planetCircles[p.id] = pc;

    const pt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    pt.setAttribute('text-anchor', 'middle');
    pt.setAttribute('dy', '-12');
    g.appendChild(pt);
    pool.planetTexts[p.id] = pt;

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    g.appendChild(title);
    pool.planetTitles[p.id] = title;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.2');
    ui.trails.appendChild(path);
    pool.trailPaths[p.id] = path;
  });

  // outer ring and marker lines
  // ensure markers layer is empty before creating elements
  while (ui.markers.firstChild) ui.markers.removeChild(ui.markers.firstChild);

  // create outer ring (single circle)
  const outerRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  outerRing.setAttribute('fill', 'none');
  outerRing.setAttribute('stroke', '#cbd5e1');
  outerRing.setAttribute('stroke-linecap', 'round');
  outerRing.setAttribute('opacity', '0.5');
  ui.markers.appendChild(outerRing);
  pool.outerRing = outerRing;

  // marker lines (one per planet)
  PLANETS.forEach(p => {
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('stroke', p.col);
    ln.setAttribute('opacity', '0.15');
    ln.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
    ui.markers.appendChild(ln);
    pool.markerLines[p.id] = ln;
  });

  // additional connector lines for moon, nodes, and sun
  const lnMoon = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  lnMoon.setAttribute('stroke', '#64748b'); lnMoon.setAttribute('opacity', '0.15'); lnMoon.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
  ui.markers.appendChild(lnMoon); pool.markerLines.moon = lnMoon;
  const lnNodeA = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  lnNodeA.setAttribute('stroke', '#ef4444'); lnNodeA.setAttribute('opacity', '0.15'); lnNodeA.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
  ui.markers.appendChild(lnNodeA); pool.markerLines.nodeA = lnNodeA;
  const lnNodeB = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  lnNodeB.setAttribute('stroke', '#6366f1'); lnNodeB.setAttribute('opacity', '0.15'); lnNodeB.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
  ui.markers.appendChild(lnNodeB); pool.markerLines.nodeB = lnNodeB;
  const lnSun = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  lnSun.setAttribute('stroke', '#fbbf24'); lnSun.setAttribute('opacity', '0.15'); lnSun.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
  ui.markers.appendChild(lnSun); pool.markerLines.sun = lnSun;

  // outer markers layer: create a text element for each planet and additional markers
  PLANETS.forEach(p => {
    const m = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    ui.markers.appendChild(m);
    pool.markerTexts[p.id] = m;
  });
  const outerMoon = document.createElementNS('http://www.w3.org/2000/svg', 'text'); ui.markers.appendChild(outerMoon); pool.outerMarkers.moon = outerMoon;
  const outerNodeA = document.createElementNS('http://www.w3.org/2000/svg', 'text'); ui.markers.appendChild(outerNodeA); pool.outerMarkers.nodeA = outerNodeA;
  const outerNodeB = document.createElementNS('http://www.w3.org/2000/svg', 'text'); ui.markers.appendChild(outerNodeB); pool.outerMarkers.nodeB = outerNodeB;
  const outerSun = document.createElementNS('http://www.w3.org/2000/svg', 'text'); ui.markers.appendChild(outerSun); pool.outerMarkers.sun = outerSun;

  // Moon group (single reusable)
  ui.moonSys.innerHTML = '';
  const mg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  ui.moonSys.appendChild(mg);
  pool.moonGroup = mg;
  const moon = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  mg.appendChild(moon);
  pool.moonElements.moon = moon;
  const orbitCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  orbitCircle.setAttribute('fill', 'none');
  mg.insertBefore(orbitCircle, moon);
  pool.moonElements.orbit = orbitCircle;
  const nodeA = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  const nodeB = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  mg.appendChild(nodeA); mg.appendChild(nodeB);
  pool.moonElements.nodeA = nodeA; pool.moonElements.nodeB = nodeB;

  // Sun
  ui.sun.innerHTML = '';
  const sunC = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const sunT = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  ui.sun.appendChild(sunC); ui.sun.appendChild(sunT);
  pool.sunCircle = sunC; pool.sunText = sunT;
}

function zMod(v) { return v / Math.pow(state.zoom, 0.6); }

function renderZodiacOverlay(earthWorldPos, anchor) {
  // Get viewport dimensions for fixed zodiac ring
  const svg = DOM.svgRoot;
  const svgRect = svg.getBoundingClientRect();
  const viewportWidth = svgRect.width || 1200;
  const viewportHeight = svgRect.height || 800;
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  
  // Transform Earth's world position to screen coordinates (moves on screen)
  const earthScreenX = state.pos.x + (earthWorldPos.x - anchor.x) * state.zoom;
  const earthScreenY = state.pos.y + (earthWorldPos.y - anchor.y) * state.zoom;
  
  const zodiacScreenRadius = 350; // fixed screen-based radius

  // Draw divider lines from Earth's screen position to fixed zodiac ring
  pool.zodiacLines.forEach((line, i) => {
    const lon = ZODIAC[i].lon; // Use actual ecliptic longitude
    const a = (lon - 90) * Math.PI / 180; // Convert to angle
    // Line goes from Earth's position to zodiac ring endpoint
    line.setAttribute('x1', earthScreenX);
    line.setAttribute('y1', earthScreenY);
    line.setAttribute('x2', centerX + zodiacScreenRadius * Math.cos(a));
    line.setAttribute('y2', centerY + zodiacScreenRadius * Math.sin(a));
    line.setAttribute('stroke', '#cbd5e1');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '10 10');
    line.setAttribute('opacity', '0.15');
  });
  
  // Draw zodiac symbols fixed on the zodiac ring (at viewport center)
  pool.zodiacText.forEach((text, i) => {
    const lon = ZODIAC[i].lon;
    const nextLon = ZODIAC[(i + 1) % ZODIAC.length].lon + (i === 11 ? 360 : 0);
    const midLon = (lon + nextLon) / 2;
    const a = (midLon - 90) * Math.PI / 180;
    const labelRadius = zodiacScreenRadius - 80;
    text.textContent = ZODIAC[i].s;
    text.setAttribute('x', centerX + labelRadius * Math.cos(a));
    text.setAttribute('y', centerY + labelRadius * Math.sin(a));
    text.setAttribute('fill', '#94a3b8');
    text.setAttribute('font-size', '28');
    text.setAttribute('font-weight', '900');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('opacity', '0.4');
  });
}

async function render() {
  const pos = await getPositions(state.days);
  const anchor = state.view === 'geo' ? (pos.earth || { x: 0, y: 0 }) : { x: 0, y: 0 };
  const stroke = (1.5 / state.zoom).toString();

  ui.world.setAttribute('transform', `translate(${state.pos.x}, ${state.pos.y}) scale(${state.zoom})`);
  
  // Render zodiac overlay with lines radiating from Earth's position
  const earthPos = pos.earth || { x: 0, y: 0 };
  renderZodiacOverlay(earthPos, anchor);
  
  // Calculate Earth's position in world coordinates (for markers ring)
  const earthX = earthPos.x - anchor.x, earthY = earthPos.y - anchor.y;

  // Orbits, planets, markers
  PLANETS.forEach(p => {
    const pPos = pos[p.id] || { x: 0, y: 0 };
    const pX = pPos.x - anchor.x, pY = pPos.y - anchor.y;
    const isCenter = state.view === 'geo' && p.id === 'earth';
    // orbit circle
    const oc = pool.orbitCircles[p.id];
    if (oc) {
      oc.setAttribute('cx', -anchor.x);
      oc.setAttribute('cy', -anchor.y);
      oc.setAttribute('r', p.dist);
      oc.setAttribute('stroke', '#e2e8f0');
      oc.setAttribute('stroke-width', stroke);
      oc.setAttribute('fill', 'none');
      oc.style.display = DOM.chkOrbits && DOM.chkOrbits.checked ? 'block' : 'none';
    }

    // planet group
    const g = pool.planetGroups[p.id];
    if (g) {
      g.setAttribute('transform', `translate(${pX}, ${pY})`);
      const pc = pool.planetCircles[p.id];
      pc.setAttribute('r', zMod(12));
      pc.setAttribute('fill', p.col);
      pc.setAttribute('stroke-width', (parseFloat(stroke) * 1.5).toString());
      const pt = pool.planetTexts[p.id];
      pt.textContent = p.sym;
      pt.setAttribute('font-size', zMod(10));
      pt.setAttribute('font-weight', '900');
      pt.setAttribute('fill', '#1e293b');
      pt.style.display = 'block';
      g.style.display = isCenter ? 'none' : 'block';
      pool.planetTitles[p.id].textContent = `${p.id.toUpperCase()}`;
    }

    // trails
    const path = pool.trailPaths[p.id];
    if (DOM.chkTrails && DOM.chkTrails.checked) {
      const pts = state.history[p.id];
      if (pts && pts.length > 1) {
        const d = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
        path.setAttribute('d', d);
        path.setAttribute('stroke', p.col);
        path.setAttribute('stroke-width', stroke);
        path.style.display = 'block';
      } else {
        path.style.display = 'none';
      }
    } else {
      path.style.display = 'none';
    }
  });

  // connector lines and outer markers will be positioned below

  // Moon system
  const ePos = pos.earth || { x: 0, y: 0 };
  const eX = ePos.x - anchor.x, eY = ePos.y - anchor.y;
  const mR = 120;
  pool.moonGroup.setAttribute('transform', `translate(${eX}, ${eY})`);
  // moon orbit circle
  if (pool.moonElements.orbit) {
    pool.moonElements.orbit.setAttribute('r', mR);
    pool.moonElements.orbit.setAttribute('stroke', '#cbd5e1');
    pool.moonElements.orbit.setAttribute('stroke-width', stroke);
    pool.moonElements.orbit.setAttribute('stroke-dasharray', `${4 / state.zoom} ${4 / state.zoom}`);
    pool.moonElements.orbit.setAttribute('fill', 'none');
  }

  pool.moonElements.moon.setAttribute('r', zMod(6));
  pool.moonElements.moon.setAttribute('cx', mR * Math.cos(pos.moonAbsAng));
  pool.moonElements.moon.setAttribute('cy', mR * Math.sin(pos.moonAbsAng));
  pool.moonElements.nodeA.textContent = '☊';
  pool.moonElements.nodeB.textContent = '☋';
  pool.moonElements.nodeA.setAttribute('x', mR * Math.cos(pos.nodeAbsAng));
  pool.moonElements.nodeA.setAttribute('y', mR * Math.sin(pos.nodeAbsAng));
  pool.moonElements.nodeA.setAttribute('font-size', zMod(18));
  pool.moonElements.nodeB.setAttribute('x', mR * Math.cos(pos.nodeAbsAng + Math.PI));
  pool.moonElements.nodeB.setAttribute('y', mR * Math.sin(pos.nodeAbsAng + Math.PI));
  pool.moonElements.nodeB.setAttribute('font-size', zMod(18));

  // Sun
  const sX = pos.sun.x - anchor.x, sY = pos.sun.y - anchor.y;
  if (state.view === 'geo') {
    pool.sunCircle.setAttribute('cx', sX); pool.sunCircle.setAttribute('cy', sY); pool.sunCircle.setAttribute('r', zMod(18));
    pool.sunText.setAttribute('x', sX); pool.sunText.setAttribute('y', sY); pool.sunText.textContent = '☉';
  } else {
    pool.sunCircle.setAttribute('cx', 0); pool.sunCircle.setAttribute('cy', 0); pool.sunCircle.setAttribute('r', zMod(22));
    pool.sunText.removeAttribute('x'); pool.sunText.removeAttribute('y'); pool.sunText.textContent = '☉';
  }
  // Outer-ring markers (planet symbols, moon, nodes, sun marker)
  const outerR = 3550;
  const outerRNode = 3650;
  // outer ring (single circle) using outerR
  if (pool.outerRing) {
    // In heliocentric view the outer markers ring should be fixed at world origin (sun).
    // In geocentric view it should be centered on Earth (earthX, earthY).
    const ringCx = state.view === 'helio' ? 0 : earthX;
    const ringCy = state.view === 'helio' ? 0 : earthY;
    pool.outerRing.setAttribute('cx', ringCx);
    pool.outerRing.setAttribute('cy', ringCy);
    pool.outerRing.setAttribute('r', outerR);
    pool.outerRing.setAttribute('stroke-width', Math.max(1.5, parseFloat(stroke)));
    pool.outerRing.setAttribute('stroke-dasharray', `${12 / state.zoom} ${6 / state.zoom}`);
    pool.outerRing.setAttribute('stroke', '#cbd5e1');
    pool.outerRing.setAttribute('opacity', '0.5');
    pool.outerRing.style.display = 'block';
  }
  PLANETS.forEach(p => {
    const pPos = pos[p.id] || { x: 0, y: 0 };
    const pX = pPos.x - anchor.x, pY = pPos.y - anchor.y;
    const ang = Math.atan2(pY, pX);
    const m = pool.markerTexts[p.id];
    const ln = pool.markerLines[p.id];
    const isCenter = state.view === 'geo' && p.id === 'earth';
    const mx = outerR * Math.cos(ang), my = outerR * Math.sin(ang);
    if (m) {
      if (isCenter) {
        m.style.display = 'none';
      } else {
        m.style.display = 'block';
        m.textContent = p.sym;
        m.setAttribute('x', mx);
        m.setAttribute('y', my);
        m.setAttribute('fill', p.col);
        m.setAttribute('font-size', zMod(36));
        m.setAttribute('font-weight', 'bold');
        m.setAttribute('text-anchor', 'middle');
        m.setAttribute('alignment-baseline', 'middle');
        m.setAttribute('opacity', '1');
      }
    }
    if (ln) {
      // line from planet position to outer marker
      ln.setAttribute('x1', pX);
      ln.setAttribute('y1', pY);
      ln.setAttribute('x2', mx);
      ln.setAttribute('y2', my);
      ln.setAttribute('stroke-width', Math.max(0.5, parseFloat(stroke) * 0.6));
      ln.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
      ln.setAttribute('stroke', p.col);
      ln.style.display = isCenter ? 'none' : 'block';
    }
  });

  // moon connector line (from moon world position to outer marker)
  if (pool.markerLines.moon) {
    const ml = pool.markerLines.moon;
    const moonWorldX = eX + mR * Math.cos(pos.moonAbsAng);
    const moonWorldY = eY + mR * Math.sin(pos.moonAbsAng);
    const mx = outerR * Math.cos(pos.moonAbsAng);
    const my = outerR * Math.sin(pos.moonAbsAng);
    ml.setAttribute('x1', moonWorldX);
    ml.setAttribute('y1', moonWorldY);
    ml.setAttribute('x2', mx);
    ml.setAttribute('y2', my);
    ml.setAttribute('stroke-width', Math.max(0.5, parseFloat(stroke) * 0.6));
    ml.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
    ml.style.display = 'block';
  }

  // lunar nodes connector lines
  if (pool.markerLines.nodeA && pool.markerLines.nodeB) {
    const lnA = pool.markerLines.nodeA;
    const lnB = pool.markerLines.nodeB;
    // Node A
    const nodeAx = eX + mR * Math.cos(pos.nodeAbsAng);
    const nodeAy = eY + mR * Math.sin(pos.nodeAbsAng);
    const nax = outerRNode * Math.cos(pos.nodeAbsAng);
    const nay = outerRNode * Math.sin(pos.nodeAbsAng);
    lnA.setAttribute('x1', nodeAx);
    lnA.setAttribute('y1', nodeAy);
    lnA.setAttribute('x2', nax);
    lnA.setAttribute('y2', nay);
    lnA.setAttribute('stroke-width', Math.max(0.5, parseFloat(stroke) * 0.6));
    lnA.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
    lnA.style.display = 'block';
    // Node B
    const nodeBx = eX + mR * Math.cos(pos.nodeAbsAng + Math.PI);
    const nodeBy = eY + mR * Math.sin(pos.nodeAbsAng + Math.PI);
    const nbx = outerRNode * Math.cos(pos.nodeAbsAng + Math.PI);
    const nby = outerRNode * Math.sin(pos.nodeAbsAng + Math.PI);
    lnB.setAttribute('x1', nodeBx);
    lnB.setAttribute('y1', nodeBy);
    lnB.setAttribute('x2', nbx);
    lnB.setAttribute('y2', nby);
    lnB.setAttribute('stroke-width', Math.max(0.5, parseFloat(stroke) * 0.6));
    lnB.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
    lnB.style.display = 'block';
  }

  // sun connector line (only show in geocentric view)
  if (pool.markerLines.sun) {
    const lSun = pool.markerLines.sun;
    if (state.view === 'geo') {
      const sAng = Math.atan2(sY, sX);
      const sx = sX;
      const sy = sY;
      const mx = outerR * Math.cos(sAng);
      const my = outerR * Math.sin(sAng);
      lSun.setAttribute('x1', sx);
      lSun.setAttribute('y1', sy);
      lSun.setAttribute('x2', mx);
      lSun.setAttribute('y2', my);
      lSun.setAttribute('stroke-width', Math.max(0.5, parseFloat(stroke) * 0.6));
      lSun.setAttribute('stroke-dasharray', `${6 / state.zoom} ${6 / state.zoom}`);
      lSun.style.display = 'block';
    } else {
      lSun.style.display = 'none';
    }
  }

  if (pool.outerMarkers.moon) {
    pool.outerMarkers.moon.textContent = '☾';
    pool.outerMarkers.moon.setAttribute('x', outerR * Math.cos(pos.moonAbsAng));
    pool.outerMarkers.moon.setAttribute('y', outerR * Math.sin(pos.moonAbsAng));
    pool.outerMarkers.moon.setAttribute('fill', '#64748b');
    pool.outerMarkers.moon.setAttribute('font-size', zMod(30));
    pool.outerMarkers.moon.setAttribute('text-anchor', 'middle');
    pool.outerMarkers.moon.setAttribute('alignment-baseline', 'middle');
  }
  if (pool.outerMarkers.nodeA && pool.outerMarkers.nodeB) {
    pool.outerMarkers.nodeA.textContent = '☊';
    pool.outerMarkers.nodeA.setAttribute('x', outerRNode * Math.cos(pos.nodeAbsAng));
    pool.outerMarkers.nodeA.setAttribute('y', outerRNode * Math.sin(pos.nodeAbsAng));
    pool.outerMarkers.nodeA.setAttribute('fill', '#ef4444');
    pool.outerMarkers.nodeA.setAttribute('font-size', zMod(24));
    pool.outerMarkers.nodeA.setAttribute('text-anchor', 'middle');
    pool.outerMarkers.nodeA.setAttribute('alignment-baseline', 'middle');

    pool.outerMarkers.nodeB.textContent = '☋';
    pool.outerMarkers.nodeB.setAttribute('x', outerRNode * Math.cos(pos.nodeAbsAng + Math.PI));
    pool.outerMarkers.nodeB.setAttribute('y', outerRNode * Math.sin(pos.nodeAbsAng + Math.PI));
    pool.outerMarkers.nodeB.setAttribute('fill', '#6366f1');
    pool.outerMarkers.nodeB.setAttribute('font-size', zMod(24));
    pool.outerMarkers.nodeB.setAttribute('text-anchor', 'middle');
    pool.outerMarkers.nodeB.setAttribute('alignment-baseline', 'middle');
  }
  if (pool.outerMarkers.sun) {
    if (state.view === 'geo') {
      const sAng = Math.atan2(sY, sX);
      pool.outerMarkers.sun.textContent = '☉';
      pool.outerMarkers.sun.setAttribute('x', outerR * Math.cos(sAng));
      pool.outerMarkers.sun.setAttribute('y', outerR * Math.sin(sAng));
      pool.outerMarkers.sun.setAttribute('fill', '#fbbf24');
      pool.outerMarkers.sun.setAttribute('font-size', zMod(36));
      pool.outerMarkers.sun.setAttribute('text-anchor', 'middle');
      pool.outerMarkers.sun.setAttribute('alignment-baseline', 'middle');
      pool.outerMarkers.sun.style.display = 'block';
    } else {
      pool.outerMarkers.sun.style.display = 'none';
    }
  }

  // update history
  Object.keys(pos).filter(k => typeof pos[k] === 'object').forEach(id => {
    if (state.history[id]) {
      state.history[id].push({ x: pos[id].x - anchor.x, y: pos[id].y - anchor.y });
      if (state.history[id].length > 200) state.history[id].shift();
    }
  });

  updateHUD();
}

function updateHUD() {
  const ms = J2000 + state.days * 86400000;
  const d = new Date(ms);
  const active = document.activeElement;
  const y = d.getUTCFullYear();
  if (active && active.id !== 'v-year' && DOM.vYear) DOM.vYear.value = (y >= 0 ? '+' : '-') + String(Math.abs(y)).padStart(6, '0');
  if (active && active.id !== 'v-month' && DOM.vMonth) DOM.vMonth.value = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (active && active.id !== 'v-day' && DOM.vDay) DOM.vDay.value = String(d.getUTCDate()).padStart(2, '0');
  if (DOM.vHour) DOM.vHour.innerText = String(d.getUTCHours()).padStart(2, '0');
  if (DOM.vMin) DOM.vMin.innerText = String(d.getUTCMinutes()).padStart(2, '0');
  if (DOM.vSec) DOM.vSec.innerText = String(d.getUTCSeconds()).padStart(2, '0');
  if (DOM.zoomLabel) DOM.zoomLabel.innerText = `ZOOM: ${state.zoom.toFixed(4)}x`;
  const dot = DOM.statusDot;
  const lab = DOM.statusLabel;
  if (state.speed > 0) {
    if (dot) dot.className = state.direction > 0 ? 'dot active' : 'dot active-rev';
    if (lab) lab.innerText = state.direction > 0 ? 'ACTIVE SIM' : 'REVERSE SIM';
  } else {
    if (dot) dot.className = 'dot';
    if (lab) lab.innerText = 'TIME LOCKED';
  }
}

function setDateFromInputs() {
  const yStr = DOM.vYear.value;
  const m = parseInt(DOM.vMonth.value, 10) - 1;
  const d = parseInt(DOM.vDay.value, 10);
  const date = new Date(Date.UTC(2000, 0, 1, 12));
  date.setUTCFullYear(parseInt(yStr, 10));
  date.setUTCMonth(m);
  date.setUTCDate(d);
  if (!isNaN(date.getTime())) {
    state.days = (date.getTime() - J2000) / 86400000;
    Object.keys(state.history).forEach(k => state.history[k] = []);
  }
}

// UI bindings
function bindUI() {
  // Wire year/month/day inputs (use cached DOM refs)
  if (DOM.vYear) {
    DOM.vYear.addEventListener('change', setDateFromInputs);
    DOM.vYear.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setDateFromInputs(); DOM.vYear.blur(); } });
  }
  if (DOM.vMonth) {
    DOM.vMonth.addEventListener('change', setDateFromInputs);
    DOM.vMonth.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setDateFromInputs(); DOM.vMonth.blur(); } });
  }
  if (DOM.vDay) {
    DOM.vDay.addEventListener('change', setDateFromInputs);
    DOM.vDay.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setDateFromInputs(); DOM.vDay.blur(); } });
  }

  const vp = DOM.viewport;
  const hud = DOM.hud;
  if (hud) hud.addEventListener('wheel', (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
  document.querySelectorAll('.unit-group').forEach(el => {
    const unit = el.dataset.unit;
    el.addEventListener('wheel', (e) => {
      e.stopPropagation(); e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      let mult = 0;
      if (unit === 'year') mult = 365.25;
      if (unit === 'month') mult = 30.44;
      if (unit === 'day') mult = 1;
      if (unit === 'hour') mult = 1 / 24;
      if (unit === 'minute') mult = 1 / 1440;
      if (unit === 'second') mult = 1 / 86400;
      state.days += dir * mult;
      Object.keys(state.history).forEach(k => state.history[k] = []);
    }, { passive: false });
  });

  window.addEventListener('mousemove', (e) => { if (state.panning) { state.pos.x += e.movementX; state.pos.y += e.movementY; } });
  window.addEventListener('mouseup', () => { state.panning = false; });
  if (vp) {
    vp.onmousedown = () => state.panning = true;
    vp.addEventListener('wheel', (e) => { e.preventDefault(); state.zoom = Math.max(0.0001, state.zoom * (e.deltaY > 0 ? 0.9 : 1.1)); }, { passive: false });
  }

  if (DOM.btnHelio) DOM.btnHelio.onclick = () => { state.view = 'helio'; DOM.btnHelio.classList.add('active'); if (DOM.btnGeo) DOM.btnGeo.classList.remove('active'); Object.keys(state.history).forEach(k => state.history[k] = []); };
  if (DOM.btnGeo) DOM.btnGeo.onclick = () => { state.view = 'geo'; DOM.btnGeo.classList.add('active'); if (DOM.btnHelio) DOM.btnHelio.classList.remove('active'); Object.keys(state.history).forEach(k => state.history[k] = []); };
  if (DOM.flowFwd) DOM.flowFwd.onclick = () => { state.direction = 1; DOM.flowFwd.classList.add('active'); if (DOM.flowRev) DOM.flowRev.classList.remove('active-rev'); };
  if (DOM.flowRev) DOM.flowRev.onclick = () => { state.direction = -1; DOM.flowRev.classList.add('active-rev'); if (DOM.flowFwd) DOM.flowFwd.classList.remove('active'); };
  if (DOM.btnSync) DOM.btnSync.onclick = () => { state.days = (Date.now() - J2000) / 86400000; };
  if (DOM.btnReset) DOM.btnReset.onclick = () => { calculateFitZoom(vp); };

  const slider = DOM.speedSlider || document.getElementById('speed-slider');
  if (slider) slider.oninput = () => { state.speed = Number(slider.value); if (DOM.speedTxt) DOM.speedTxt.innerText = 'x' + state.speed; };

  // display toggles
  if (DOM.chkOrbits) DOM.chkOrbits.addEventListener('change', () => { /* handled in render */ });
  if (DOM.chkTrails) DOM.chkTrails.addEventListener('change', () => { /* handled in render */ });
}

// Planet scale/label UI removed per user request.

function calculateFitZoom(vp) {
  // Calculate zoom to fit zodiac ring (radius ~6000) in viewport
  const maxRadius = 6000;
  const viewWidth = vp.clientWidth - 320; // subtract sidebar
  const viewHeight = vp.clientHeight;
  const fitZoomX = (viewWidth * 0.4) / maxRadius; // 40% of viewport width
  const fitZoomY = (viewHeight * 0.4) / maxRadius; // 40% of viewport height
  state.zoom = Math.min(fitZoomX, fitZoomY, 0.5); // cap at 0.5
  state.pos = { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
}

let rafId = null;
function loop() {
  if (state.speed > 0) state.days += (state.speed / 1000) * state.direction;
  render();
  rafId = requestAnimationFrame(loop);
}

async function init() {
  await tryAutoProvider();
  initPools();
  bindUI();
  const vp = DOM.viewport || document.getElementById('viewport');
  calculateFitZoom(vp);
  loop();
}

init();
