# Game Plan: Hexbloom

## Overview
- **Name:** Hexbloom
- **Repo name:** hexbloom
- **Tagline:** Pick a colour, bloom your blob across the honeycomb, and claim more tiles than your rivals.
- **Genre (directory category):** board

## Core Loop
A hex grid is fully painted in six colours. You own one corner; each rival owns
another. On your turn you pick any colour except your current one — your whole
territory recolours to it and instantly **absorbs every touching tile of that
colour**, blooming outward. Rivals do the same from their corners. The board is
finite, so the two (or three, or four) blobs race to swallow neutral ground.
When no neutral tiles remain, the biggest territory wins. The tension is
board-reading: the colour that grabs the most *now* often isn't the one that
opens the most frontier for *next* turn — and a colour your rival needs is one
you can starve.

## Controls
- **Desktop:** click a colour swatch (or press keys 1–6) to play your turn. `R` restart, `M` mute, `Esc`/menu button to pause.
- **Mobile:** tap a colour swatch (≥44px targets). Everything is tap-driven — no drag, no hover.

## Multiplayer
- **Mode:** live P2P (also fully playable solo vs 1–3 AI rivals).
- **If live P2P:** players 2–4; topology **host-authoritative** (board is tiny — ≤81 bytes — so the host applies each move to the canonical state and broadcasts a full snapshot). Channels: `mv` (client → host: chosen colour), `snap` (host → all: full board snapshot), `sync` (client → host: "send me the current snapshot" on join). Late joiners after the game starts become **spectators** (they render snapshots, can't move); the fixed player↔peer mapping is derived identically on every peer from the sorted lobby roster + shared seed. If the host leaves, `net.ts` re-elects the lowest peer id, which adopts its last received snapshot and continues.

## Juice Plan
- **Absorb pop:** every newly-claimed tile bounces (scale spring) and emits a particle burst in its colour (`sound.play('coin')`, pitch scales with cascade size).
- **Screen shake:** proportional to how many tiles a bloom claimed — a 12-tile cascade really thumps (`sound.play('powerup')` on big blooms). Respects `prefers-reduced-motion` (no shake, reduced particles).
- **Turn feedback:** the active player's swatch row and score chip pulse; your locked (current) colour is dimmed. `select` blip on swatch tap, `win`/`lose` sting on game over with confetti.
- **Palette:** Okabe–Ito colour-blind-safe six, defined as CSS custom properties; neutral tiles sit at reduced opacity so the two vivid blobs read at a glance, with an optional per-colour **symbol overlay** toggle for extra a11y.

## Style Direction
**Vibe:** clean-minimal with arcade juice — a calm honeycomb that erupts on capture.
**Palette:** Okabe–Ito (orange, sky, green, yellow, blue, vermillion) — designed for deuteranopia/protanopia; owner blobs get a contrasting accent stroke. Dark theme.
**Theme:** dark (the vivid tiles glow against near-black).
**Reference feel:** the satisfying cascades of a good "Filler"/flood game and the tactility of KAMI — feel only, no IP.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** DOM + inline **SVG** for the crisp hex board (easy hit targets, accessible, responsive), with a thin `<canvas>` particle overlay for pops and CSS transform for shake.
- **Engine modules copied from patterns/:** net, lobby, rng, sound, storage. (No `loop.ts`/`input.ts` — the game is turn-based and tap-driven; rAF is used only for the particle/shake visual layer.)
- **Persistence:** localStorage via storage.ts — settings (mute, symbols, last opponent count/difficulty), "seen how-to", and a solo record board (wins, best margin).

## Non-Goals
- No per-turn time clock (turn-based, no time pressure — so no rAF-vs-setInterval countdown hazard).
- No AI in multiplayer rooms (rooms are all-human; solo is all-AI rivals).
- No ranked/global leaderboard (local records only; zero backend).

## How To Play (player-facing copy)
Pick a colour to flood your blob. Your whole territory turns that colour and
swallows every touching tile of it — so bigger clusters mean bigger gains. You
can't pick the colour you already are. When the board runs out of neutral tiles,
the largest territory wins. Play solo against the AI, or share the room link to
bloom head-to-head with up to three friends.
