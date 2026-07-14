# Hexbloom

**Pick a colour, bloom your blob across the honeycomb, and claim more tiles than your rivals.**

🎮 Play: https://hexbloom.benrichardson.dev

## What it is
Hexbloom is a tiny turn-based area-control board game — an original take on the
classic "flood / filler" mechanic, played on a hexagonal grid for one to four
players. The board starts painted in six colours; you own one corner, each rival
owns another.

On your turn you pick any colour except the one you already are. Your whole
territory recolours to it and instantly **absorbs every touching tile of that
colour**, blooming outward in a satisfying cascade. Bigger same-colour clusters
mean bigger gains — but the colour that grabs the most *right now* often isn't the
one that opens the most frontier for next turn, and a colour your rival needs is
one you can starve first. When the board runs out of neutral tiles, the largest
territory wins.

It's instantly playable solo against the AI (three difficulties), and genuinely
fun head-to-head with friends over a shared link.

## How to play
- **Pick a colour** to flood your blob — click a swatch (desktop) or tap it (mobile).
  Each swatch shows how many tiles it would capture.
- **You can't pick the colour you already are.**
- **Rivals bloom from their corners too** — grab contested ground first.
- **Largest territory when the board fills wins.**
- Desktop keys: `1`–`6` pick a colour, `R` restarts a solo game, `M` mutes.
- An optional colour-blind **symbol overlay** puts a unique glyph on each colour.

## Multiplayer
Live **peer-to-peer** for 2–4 players. Tap *Play with friends* to open a room and
share the link (or use Web Share on mobile). It's **host-authoritative**: the
elected host holds the canonical board and broadcasts a full snapshot after each
move; clients send their chosen colour. There is **no game server** — your
browsers connect directly over WebRTC, and a free public signalling relay only
brokers the initial handshake. Everyone shares one seed so the board is identical
on every screen. If the host leaves, a new one is elected automatically and the
game continues; if a seated player drops on their turn, the host plays a move for
them so nothing stalls. Late joiners spectate. The game is always fully playable
solo if nobody joins.

## Tech
- Vite 6 + vanilla TypeScript
- Inline SVG board rendering with a `<canvas>` particle overlay and screen shake
- Shared engine: deterministic seedable RNG, procedural Web Audio, unified
  storage, Trystero P2P netcode + lobby
- Vitest for game logic, board-generation determinism, and P2P snapshot / lockstep
  sync tests
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License
MIT
