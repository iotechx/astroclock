# ORRERY PRO — Learning Manual

## Overview

Orrery Pro is a single-file, client-side interactive orrery (solar system model) implemented in `index.html`. It renders an SVG-based visualization of the Sun, planets, and Moon system and provides editable time controls (an "editable epoch") so the user can step the simulation forward/backward, change the epoch, toggle display layers, and switch between heliocentric and geocentric frames.

This manual explains the high-level architecture, core concepts, important functions and data structures, UI controls, and guides for extending the app.

---

## Project layout

- Single entry: [index.html](index.html#L1-L4000)
  - All CSS, SVG, and JavaScript are embedded in the same file for simplicity.

---

## High-level architecture

- Presentation: SVG DOM inside the `<svg id="svg-root">` element. Visual layers use `<g>` groups (zodiac, orbits, trails, markers, sun, planets, moon system).
- State model: a single `state` object holds simulation time (`days` since J2000), view mode (`helio` or `geo`), `speed`, `direction`, `zoom`, `pos` (pan), and a `history` buffer for trail rendering.
- Data model: `PLANETS` array describes planets (id, symbol, color, distance, angular rate, base longitude).
- Update loop: a `loop()` function driven by `requestAnimationFrame` updates `state.days` when `state.speed > 0`, calls `render()`, and requests the next frame.
- Rendering: `render()` computes positions via `getPositions(days)`, composes SVG elements by setting `innerHTML` on layer groups, and updates HUD elements.
- Input/Events: DOM event listeners handle mouse/touch interactions (pan, zoom), HUD edits, toggles, sliders, and buttons.

---

## Core concepts

- Epoch & time base: The simulation uses J2000 (2000-01-01T12:00:00Z) as reference. `state.days` is the number of days since J2000 and is the primary independent variable used for computing celestial positions.
- Simple orbital model: Planetary longitudes are computed with a linear rate term per planet (not a full ephemeris). `getPositions()` converts those longitudes to x,y coordinates using a fixed `dist` (display radius) per planet. The Moon and lunar nodes are simulated with simple periodic formulas.
- Coordinate frames: Two frames are supported: `helio` (Sun at origin) and `geo` (Earth used as anchor). Switching recalculates anchors and clears history so trails redraw relative to the chosen center.
- Level-of-detail (LOD) via `zoom`: Visual sizes and stroke widths are scaled using `zoom` and a helper `zMod(v)` inside `render()`.
- Trails: `state.history` keeps recent positions per body (capped in the code) and `render()` draws them as SVG paths when enabled.

---

## Important data structures & constants

- `J2000` — reference timestamp (ms) for epoch zero.
- `ZODIAC` — array of zodiac glyphs used for background markers.
- `PLANETS` — array with objects like `{ id, sym, col, dist, rate, long }`.
- `state` — runtime object: `{ days, view, speed, direction, zoom, pos, panning, history }`.
- `ui` — cached DOM references for main layers: `world`, `zodiac`, `orbits`, `trails`, `markers`, `planets`, `sun`, `moonSys`.

---

## Key functions (map to code)

- `getPositions(days)` — compute x,y for each planet and moon/node angles. (Search in `index.html` for `function getPositions`.)
- `render()` — main renderer: clears layers, draws zodiac lines, orbits, planet markers, moon system, sun, and trails; updates `state.history` and HUD.
- `updateHUD()` — synchronize HUD fields and status indicators based on `state`.
- `setDateFromInputs()` — parse HUD input fields and update `state.days`.
- `loop()` — simulation loop calling `render()` and incrementing `state.days` when `state.speed > 0`.

Refer to the in-file implementations for exact math and DOM element IDs.

---

## UI overview and controls

- Left sidebar: controls for frame (`HELIOCENTRIC` / `GEOCENTRIC`), flow direction (FORWARD / REVERSE), speed slider (`#speed-slider`), toggles for display layers (orbital paths, motion trails), and buttons `SYNC TO NOW` and `RESET VIEW`.
- HUD (bottom-right): editable epoch input fields for `YEAR`, `M`, `D` and read-only `H` and `M` (hour/minute); zoom label; status dot and label.
- Interactions:
  - Pan: click+drag on viewport to translate the world.
  - Zoom: mouse wheel on viewport to change `state.zoom`.
  - HUD wheel: roll on individual unit groups to nudge year/month/day/hour/minute.
  - Direct edits: change `v-year`, `v-month`, `v-day` and press Enter or blur to set the epoch.

---

## Rendering & performance notes

- The renderer uses `innerHTML` assignments to rebuild groups each frame. This is easy to implement but can be heavier for complex scenes; consider using element creation + reuse for better performance when scaling.
- Trail history is stored in arrays per body and trimmed to a fixed length (`200` in the code). Lowering the max length helps memory and rendering cost.
- LOD scaling is applied using `zMod(v)` and `stroke` computations so visuals remain consistent as `zoom` changes.

---

## How to run and test locally

- Open `index.html` in a modern browser (Chrome / Edge / Firefox). No build step is required.
- Interact with the controls in the left sidebar and the HUD to verify behavior.
- For debugging, open DevTools and inspect the `state` object or set breakpoints in the inline `<script>`.

---

## Extending the app — practical suggestions

- Replace the simple linear longitude model with a proper ephemeris library (e.g., `astronomia`, `meeus`, or a WASM ephemeris) for accurate positions.
- Move JavaScript into a separate module file (e.g., `src/sim.js`) and convert the app to an ES module to improve maintainability and enable unit testing.
- Rework rendering to reuse SVG elements instead of replacing `innerHTML` every frame. Keep a pool of elements per planet and update attributes for smoother animation.
- Add UI to change planet `dist` and toggle labels/tooltip info for each body. Provide presets (e.g., "scale to real AU", "compact view").
- Add mobile touch gesture support (pinch-to-zoom, two-finger pan) and accessibility improvements (keyboard controls, ARIA labels).

---

## Glossary

- Orrery — a mechanical or visual model of the solar system showing planetary motion.
- J2000 — Julian epoch starting at 2000-01-01 12:00 UTC; common astronomical reference.
- Epoch — the reference date/time for astronomical coordinates.
- Heliocentric — Sun-centered coordinate frame.
- Geocentric — Earth-centered coordinate frame.

---

## Quick pointers to explore in code

- Look at the `PLANETS` array near the top of the script to change symbols, colors, or orbital parameters.
- Inspect `getPositions()` and `render()` to understand how positions map to SVG coordinates.
- Check event handlers near the bottom of the script for UI interactions and how `state` is mutated.

---

If you want, I can:
- split the code into separate files and add a small build or dev server setup,
- or convert the renderer to reuse DOM nodes for a performance upgrade.

