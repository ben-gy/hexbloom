/**
 * ui.ts — static markup builders and modal helpers for Hexbloom. Dynamic in-game
 * surfaces (HUD, palette, results) are assembled in main.ts; this file holds the
 * menu, setup, how-to/about content, the footer, and a generic modal.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export const FOOTER_HTML = `
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://sites.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;

export function menuHTML(record: { wins: number; games: number; bestMargin: number }): string {
  const rec =
    record.games > 0
      ? `<p class="menu-record">Solo record: <strong>${record.wins}</strong> win${record.wins === 1 ? '' : 's'} of ${record.games} · best margin +${record.bestMargin}</p>`
      : `<p class="menu-record">Learn it in one game — pick a colour, grow your blob.</p>`;
  return `
    <section class="screen menu" aria-labelledby="title">
      <div class="brand">
        <div class="brand-hex" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <h1 id="title" class="brand-title">Hexbloom</h1>
        <p class="brand-tag">Bloom your colour across the honeycomb and claim the most tiles.</p>
      </div>
      ${rec}
      <div class="menu-actions">
        <button class="btn btn-primary" data-act="solo">Play solo</button>
        <button class="btn" data-act="friends">Play with friends</button>
        <button class="btn btn-ghost" data-act="howto">How to play</button>
        <button class="btn btn-ghost" data-act="about">About</button>
      </div>
      <div class="menu-toggles">
        <button class="chip-toggle" data-act="mute" aria-pressed="false"></button>
        <button class="chip-toggle" data-act="symbols" aria-pressed="false"></button>
      </div>
    </section>`;
}

export function soloSetupHTML(defaults: { rivals: number; difficulty: string }): string {
  const rivalBtn = (n: number, label: string) =>
    `<button class="opt ${defaults.rivals === n ? 'sel' : ''}" data-rivals="${n}">${label}</button>`;
  const diffBtn = (id: string, label: string) =>
    `<button class="opt ${defaults.difficulty === id ? 'sel' : ''}" data-diff="${id}">${label}</button>`;
  return `
    <section class="screen setup">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <h2>Solo match</h2>
      <div class="setup-group">
        <span class="setup-label">Rivals</span>
        <div class="opts">
          ${rivalBtn(1, '1 rival')}${rivalBtn(2, '2 rivals')}${rivalBtn(3, '3 rivals')}
        </div>
      </div>
      <div class="setup-group">
        <span class="setup-label">Difficulty</span>
        <div class="opts">
          ${diffBtn('easy', 'Casual')}${diffBtn('normal', 'Sharp')}${diffBtn('hard', 'Ruthless')}
        </div>
      </div>
      <button class="btn btn-primary setup-start" data-act="start">Start match</button>
    </section>`;
}

export const HOWTO_HTML = `
  <p>The board is a honeycomb painted in six colours. You start owning one corner;
  each rival owns another.</p>
  <ul>
    <li><strong>Pick a colour</strong> — your whole territory turns that colour and
      instantly <strong>swallows every touching tile of it</strong>. Bigger clusters
      mean bigger gains.</li>
    <li>You <strong>can't pick the colour you already are</strong>.</li>
    <li>Rivals bloom from their corners too — grab the ground they want first.</li>
    <li>When no neutral tiles are left, the <strong>largest territory wins</strong>.</li>
  </ul>
  <p class="howto-controls">Desktop: click a swatch or press <kbd>1</kbd>–<kbd>6</kbd>.
  Mobile: tap a swatch. <kbd>R</kbd> restarts a solo game, <kbd>M</kbd> mutes.</p>`;

export const ABOUT_HTML = `
  <p><strong>Hexbloom</strong> is a tiny area-control board game — an original take on
  the classic "flood / filler" mechanic, on a hex grid, for one to four players.</p>
  <p>Play solo against the AI, or tap <em>Play with friends</em> to open a room and
  share the link. Multiplayer is <strong>peer-to-peer</strong>: your browsers connect
  directly over WebRTC with <strong>no game server</strong>. A free public signalling
  relay only helps the browsers find each other for the first handshake — no game data
  is stored anywhere.</p>
  <p>No accounts, no cookies, no tracking beyond anonymous, cookie-less page-view counts
  (Cloudflare Web Analytics). All art and sound are generated in code.</p>
  <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>`;

/** Open a modal dialog. Returns a close function. */
export function openModal(title: string, bodyHTML: string): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head">
        <h2>${escapeHtml(title)}</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return close;
}
