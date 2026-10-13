// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * render.ts — draws the Hexbloom board as inline SVG (crisp, accessible, and
 * responsive by construction via a viewBox) with a thin <canvas> overlay for
 * particle pops and a CSS transform for screen shake. Display-only: input comes
 * from the colour palette in ui.ts, never from the board itself.
 */

import type { GameState } from './game';
import { neighbors, NEUTRAL } from './game';

const SQRT3 = Math.sqrt(3);
const S = 10; // hex radius in viewBox units
/**
 * One glyph per tile colour, for symbol mode. Exported ONLY so a test can hold
 * it to the same length as TILE_COLORS: this is the parallel array to the
 * palette, and a colour without a glyph is read as `SYMBOLS[col] ?? ''` — an
 * empty hex, no throw, no warning. That failure is invisible to everyone except
 * the colour-blind players symbol mode exists for, which is the worst possible
 * audience for a silent bug. TILE_COLORS is pinned against the modes; this is
 * pinned against TILE_COLORS.
 */
export const SYMBOLS = ['●', '▲', '■', '◆', '✦', '★', '✚'];

/**
 * Okabe–Ito colour-blind-safe palette (tile colours).
 *
 * Seven, because Wilds paints the board in seven. This is the whole of Okabe–Ito
 * bar black, and there is no eighth: the set was designed as eight and black is
 * spoken for by PLAYER_ACCENTS below. So a mode may not ask for more than seven
 * colours — modes.ts says so and tests/modes.test.ts holds it to it. Reaching
 * for a "nice purple" to make an eight-colour mode work would quietly cost the
 * colour-blind safety that is the reason this palette is not prettier.
 */
export const TILE_COLORS = [
  '#e69f00', // orange
  '#56b4e9', // sky
  '#009e73', // green
  '#f0e442', // yellow
  '#0072b2', // blue
  '#d55e00', // vermillion
  '#cc79a7', // reddish purple
];

/** Per-player accent used for owner outlines + UI (distinct from tile colours). */
export const PLAYER_ACCENTS = ['#ffffff', '#111318', '#ff4fa3', '#00e5d0'];
export const PLAYER_NAMES_DEFAULT = ['You', 'Rival', 'Rival 2', 'Rival 3'];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  r: number;
}

export class BoardView {
  readonly root: HTMLElement;
  private svg!: SVGSVGElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D | null;
  private cells: SVGPolygonElement[] = [];
  private glyphs: SVGTextElement[] = [];
  private centers: { cx: number; cy: number }[] = [];
  private boardW = 0;
  private boardH = 0;
  private particles: Particle[] = [];
  private raf = 0;
  private shakeUntil = 0;
  private shakeAmp = 0;
  private symbols = false;
  private reduced = false;
  private ro?: ResizeObserver;

  constructor(root: HTMLElement) {
    this.root = root;
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setSymbols(on: boolean): void {
    this.symbols = on;
    for (const g of this.glyphs) g.style.display = on ? '' : 'none';
  }

  build(state: GameState): void {
    this.root.innerHTML = '';
    this.cells = [];
    this.glyphs = [];
    this.centers = [];

    const { w, h } = state;
    this.boardW = S * SQRT3 * (w + 0.5);
    this.boardH = S * 1.5 * (h - 1) + 2 * S;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${this.boardW} ${this.boardH}`);
    svg.setAttribute('class', 'board-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Hexbloom board');

    for (let i = 0; i < w * h; i++) {
      const col = i % w;
      const row = Math.floor(i / w);
      const cx = S * SQRT3 * (col + 0.5 * (row & 1)) + (S * SQRT3) / 2;
      const cy = S * 1.5 * row + S;
      this.centers.push({ cx, cy });

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', hexPoints(cx, cy, S * 0.96));
      poly.setAttribute('class', 'hex');
      poly.style.transformOrigin = `${cx}px ${cy}px`;
      svg.appendChild(poly);
      this.cells.push(poly);

      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(cx));
      t.setAttribute('y', String(cy));
      t.setAttribute('class', 'hex-sym');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('font-size', String(S * 0.9));
      t.style.display = this.symbols ? '' : 'none';
      svg.appendChild(t);
      this.glyphs.push(t);
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'board-fx';
    canvas.setAttribute('aria-hidden', 'true');

    this.root.appendChild(svg);
    this.root.appendChild(canvas);
    this.svg = svg;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.sizeCanvas());
    this.ro.observe(this.root);
    this.sizeCanvas();
    this.paint(state);
  }

  private sizeCanvas(): void {
    if (!this.canvas) return;
    const rect = this.svg.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
  }

  /** Repaint fills/owners. Optionally highlight the given cells (last move). */
  paint(state: GameState, highlight?: number[]): void {
    const hi = highlight ? new Set(highlight) : null;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const owner = state.owner[i];
      const col = state.tile[i];
      c.setAttribute('fill', TILE_COLORS[col]);
      if (owner === NEUTRAL) {
        c.setAttribute('class', 'hex neutral');
        c.setAttribute('stroke', 'rgba(0,0,0,0.35)');
        c.setAttribute('stroke-width', '0.6');
      } else {
        c.setAttribute('class', 'hex owned');
        c.setAttribute('stroke', PLAYER_ACCENTS[owner] ?? '#fff');
        c.setAttribute('stroke-width', '1.4');
      }
      const g = this.glyphs[i];
      g.textContent = SYMBOLS[col] ?? '';
      g.setAttribute('fill', owner === NEUTRAL ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.62)');
    }
    if (hi) {
      for (const i of hi) {
        const c = this.cells[i];
        if (!c) continue;
        c.classList.remove('pop');
        // Force reflow so re-adding the class restarts the animation.
        void c.getBBox();
        c.classList.add('pop');
      }
    }
  }

  /** Burst particles from a set of cells in a colour, and shake. */
  burst(cells: number[], colorIndex: number, intensity: number): void {
    if (!this.ctx || cells.length === 0) return;
    const color = TILE_COLORS[colorIndex];
    const per = this.reduced ? 0 : Math.min(6, 2 + Math.floor(intensity / 3));
    const scale = this.canvas.clientWidth / this.boardW || 1;
    for (const idx of cells) {
      const c = this.centers[idx];
      if (!c) continue;
      for (let k = 0; k < per; k++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.4 + Math.random() * 1.6;
        this.particles.push({
          x: c.cx * scale,
          y: c.cy * scale,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0,
          max: 420 + Math.random() * 360,
          color,
          r: (1.4 + Math.random() * 2.2) * scale * 0.9,
        });
      }
    }
    if (!this.reduced) {
      this.shakeAmp = Math.min(10, 2 + intensity * 0.6);
      this.shakeUntil = performance.now() + 220;
    }
    this.ensureLoop();
  }

  private ensureLoop(): void {
    if (this.raf) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      this.tick(dt, now);
      if (this.particles.length || now < this.shakeUntil) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.raf = 0;
        this.root.style.transform = '';
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  private tick(dt: number, now: number): void {
    const ctx = this.ctx;
    if (ctx) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const next: Particle[] = [];
      for (const p of this.particles) {
        p.life += dt;
        if (p.life >= p.max) continue;
        p.x += p.vx * (dt / 16);
        p.y += p.vy * (dt / 16);
        p.vy += 0.04 * (dt / 16);
        const a = 1 - p.life / p.max;
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.6 + a * 0.4), 0, Math.PI * 2);
        ctx.fill();
        next.push(p);
      }
      ctx.globalAlpha = 1;
      this.particles = next;
    }
    if (now < this.shakeUntil && this.shakeAmp > 0) {
      const t = (this.shakeUntil - now) / 220;
      const amp = this.shakeAmp * t;
      const dx = (Math.random() * 2 - 1) * amp;
      const dy = (Math.random() * 2 - 1) * amp;
      this.root.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
    } else {
      this.root.style.transform = '';
    }
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.particles = [];
    this.root.style.transform = '';
    this.root.innerHTML = '';
  }
}

function hexPoints(cx: number, cy: number, s: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (-90 + 60 * k);
    pts.push(`${(cx + s * Math.cos(a)).toFixed(2)},${(cy + s * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Convenience: cells adjacent to a player's blob (unused by render but handy). */
export function frontierCells(state: GameState, player: number): number[] {
  const out = new Set<number>();
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] !== player) continue;
    for (const n of neighbors(i, state.w, state.h)) if (state.owner[n] === NEUTRAL) out.add(n);
  }
  return [...out];
}
