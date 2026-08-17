/**
 * Builds the profile README's cards from the GitHub API.
 *
 *   GITHUB_TOKEN=... node generate.mjs        measure, then draw
 *   node generate.mjs --offline               redraw from telemetry.json
 *
 * Writes telemetry.json (the numbers) and assets/*.svg in both themes.
 * Nothing here is pinned to a repository name or a fixed repo count, so it
 * keeps working as repositories are added.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OFFLINE = process.argv.includes('--offline');

/* -------------------------------------------------------------- settings */

const CONFIG = {
  login: process.env.GH_LOGIN || 'toomanybits',
  /** Languages listed on the composition card. The card resizes to fit. */
  topLanguages: 9,
  /** A repo counts as "active" if it was pushed to within this many days. */
  activeDays: 30,
  /**
   * Language bytes measure file size, not focus, and a few large repos can
   * decide the whole chart. Each repo's bytes are scaled down to at most the
   * median repo's size before being summed, so a big repo still outweighs a
   * small one but none can drown the rest. The median is recomputed on every
   * run, so this keeps holding as the repo list grows and its shape changes.
   */
  balanceByRepoSize: true,
  /** Language rows per legend line on the composition card. */
  legendColumns: 5,
};

/**
 * Local token file, gitignored. Keeps the token out of the shell history and
 * out of CI config; Actions supplies GITHUB_TOKEN through the environment
 * instead, so this file only ever exists on a developer machine.
 */
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const TOKEN = process.env.GITHUB_TOKEN || process.env.TELEMETRY_TOKEN || '';

/* ------------------------------------------------------------------ fetch */

const gql = async (query, variables) => {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': `${CONFIG.login}-profile`,
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`graphql ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`graphql: ${errors[0].message}`);
  return data;
};

const REPOS = `
query($login:String!,$after:String){
  user(login:$login){
    createdAt
    pullRequests(first:1){totalCount}
    merged: pullRequests(states:MERGED,first:1){totalCount}
    issues(first:1){totalCount}
    repositories(first:100,after:$after,ownerAffiliations:OWNER,isFork:false){
      pageInfo{ hasNextPage endCursor }
      nodes{
        isPrivate pushedAt stargazerCount
        releases(first:1){totalCount}
        languages(first:30,orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } }
      }
    }
  }
}`;

/** Walks every page, so the repo list is never silently truncated. */
async function fetchRepos() {
  const nodes = [];
  let after = null;
  let user = null;
  do {
    const data = await gql(REPOS, { login: CONFIG.login, after });
    user = data.user;
    nodes.push(...user.repositories.nodes);
    after = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (after);
  return { user, nodes };
}

/**
 * Lifetime commit contributions. contributionsCollection caps each query at a
 * one-year window, so the range from account creation to now is split into
 * yearly slices and summed. The slice count grows with account age on its own.
 * Restricted counts are private contributions, included as an opaque total.
 */
async function lifetimeCommits(createdAt) {
  const now = new Date();
  const windows = [];
  for (let a = new Date(createdAt); a < now; ) {
    const b = new Date(Math.min(new Date(a).setFullYear(a.getFullYear() + 1) - 1, now.getTime()));
    windows.push([a.toISOString(), b.toISOString()]);
    a = new Date(b.getTime() + 1);
  }
  const fields = windows
    .map(
      (_, i) =>
        `y${i}: contributionsCollection(from:$f${i},to:$t${i}){totalCommitContributions restrictedContributionsCount}`,
    )
    .join(' ');
  const args = windows.map((_, i) => `$f${i}:DateTime!,$t${i}:DateTime!`).join(',');
  const vars = { login: CONFIG.login };
  windows.forEach(([f, t], i) => {
    vars[`f${i}`] = f;
    vars[`t${i}`] = t;
  });
  const data = await gql(`query($login:String!,${args}){user(login:$login){${fields}}}`, vars);
  return Object.values(data.user).reduce(
    (n, w) => n + w.totalCommitContributions + w.restrictedContributionsCount,
    0,
  );
}

/** Colours come from the API, so a language we have never seen still renders. */
function languageSplit(repos) {
  const totals = repos.map((r) => r.languages.edges.reduce((n, e) => n + e.size, 0));
  const sizes = totals.filter(Boolean).sort((a, b) => a - b);
  if (!sizes.length) return { measured: false, balanced: false, items: [] };
  const cap = CONFIG.balanceByRepoSize ? sizes[Math.floor(sizes.length / 2)] : Infinity;

  const bytes = new Map();
  const colors = new Map();
  repos.forEach((r, i) => {
    if (!totals[i]) return;
    const scale = Math.min(1, cap / totals[i]);
    for (const e of r.languages.edges) {
      bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size * scale);
      if (e.node.color) colors.set(e.node.name, e.node.color);
    }
  });

  const ranked = [...bytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, CONFIG.topLanguages);
  const total = ranked.reduce((n, [, size]) => n + size, 0);
  return {
    measured: true,
    balanced: CONFIG.balanceByRepoSize,
    items: ranked.map(([name, size]) => ({
      name,
      pct: total ? +((size / total) * 100).toFixed(2) : 0,
      color: colors.get(name) || null,
    })),
  };
}

async function measure() {
  if (!TOKEN) {
    console.error(
      'no token: set GITHUB_TOKEN or TELEMETRY_TOKEN (locally, put it in .env.local),\n' +
        'or pass --offline to redraw from the existing telemetry.json.',
    );
    process.exit(1);
  }
  const { user, nodes } = await fetchRepos();
  const pub = nodes.filter((r) => !r.isPrivate);
  const active = (r) => Date.now() - Date.parse(r.pushedAt) < CONFIG.activeDays * 864e5;

  return {
    signals: {
      measured: true,
      commits: await lifetimeCommits(user.createdAt),
      prs: user.pullRequests.totalCount,
      prsMerged: user.merged.totalCount,
      issues: user.issues.totalCount,
      stars: pub.reduce((n, r) => n + r.stargazerCount, 0),
      releases: pub.filter((r) => r.releases.totalCount > 0).length,
      activeRepos: pub.filter(active).length,
      activeDays: CONFIG.activeDays,
    },
    // Bytes come from every owned repo including private ones, because the
    // public repos alone describe work that stopped in 2023. Only aggregate
    // names and totals are kept — no repository is ever named or counted here.
    languages: languageSplit(nodes),
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ theme */

const W = 850;
const MONO =
  "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";

const THEMES = {
  light: { ink: '#1e1e2e', ink2: '#4c4f69', dim: '#6c6f85', faint: '#9ca0b0',
    accent: '#8839ef', ok: '#40a02b', line: '#dce0e8', cardBg: '#f6f7f9' },
  dark: { ink: '#cdd6f4', ink2: '#bac2de', dim: '#7f849c', faint: '#585b70',
    accent: '#cba6f7', ok: '#a6e3a1', line: '#313244', cardBg: '#181825' },
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Monospace advance width is a stable ~0.6em, which makes layout computable. */
const measureText = (s, size) => s.length * size * 0.6;

const svg = (h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" ` +
  `fill="none" font-family="${MONO}" role="img">${body}</svg>\n`;

const text = (x, y, s, { size = 12, fill, weight = 400, spacing = 0, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
  (spacing ? ` letter-spacing="${spacing}"` : '') +
  (anchor !== 'start' ? ` text-anchor="${anchor}"` : '') +
  `>${esc(s)}</text>`;

const card = (h, t) =>
  `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="6" fill="${t.cardBg}" stroke="${t.line}"/>`;

/** Card title bar: label left, provenance right, rule underneath. */
const heading = (label, note, t) =>
  text(18, 24, label, { size: 11, fill: t.dim, weight: 700, spacing: 1.6 }) +
  text(W - 18, 24, note, { size: 10, fill: t.faint, anchor: 'end', spacing: 1 }) +
  `<rect x="1" y="34" width="${W - 2}" height="1" fill="${t.line}"/>`;

/* ------------------------------------------------------------------ cards */

/** Edit this list freely — the card grows a row at a time to fit. */
const AREAS = [
  ['WEB DEVELOPMENT', 'Websites · Web Apps · SaaS · Frontend · Backend'],
  ['CMS & WORDPRESS', 'WordPress · WooCommerce · Themes · Plugins · ACF'],
  ['BUSINESS SYSTEMS', 'CRMs · Internal Tools · Dashboards · Portals'],
  ['EXTENSIONS & TOOLS', 'Browser Extensions · Bots · Custom Utilities'],
  ['CLOUD & INTEGRATIONS', 'APIs · Webhooks · Integrations · Cloud · VPS'],
  ['AUTOMATION', 'n8n · Make · Zapier · Pabbly · Business Automation'],
  ['AI / LLM', 'LLMs · AI Agents · RAG · AI Workflows'],
];

const whatibuild = (t) => {
  const pitch = 32;
  const top = 62;
  const h = top + AREAS.length * pitch;

  let b = card(h, t) + heading('WHAT I BUILD', `${AREAS.length} areas`, t);
  AREAS.forEach(([label, items], i) => {
    const y = top + i * pitch;
    if (i) b += `<rect x="18" y="${y - 21}" width="${W - 36}" height="1" fill="${t.line}"/>`;
    b += `<rect x="18" y="${y - 9}" width="3" height="12" fill="${t.accent}"/>`;
    b += text(31, y, label, { size: 11.5, fill: t.ink, weight: 700, spacing: 1.2 });
    b += text(250, y, items, { size: 11.5, fill: t.dim });
  });
  return svg(h, b);
};

const signals = (t, data) => {
  const s = data.signals || {};
  const cells = [
    [s.commits, 'commits'],
    [s.prs, s.prs === 1 ? 'PR' : 'PRs'],
    [s.prsMerged, 'merged'],
    [s.issues, s.issues === 1 ? 'issue' : 'issues'],
    [s.stars, s.stars === 1 ? 'star' : 'stars'],
    [s.releases, s.releases === 1 ? 'release' : 'releases'],
  ];
  const VS = 20;
  const NS = 12.5;
  const pitch = 36;
  const top = 66;
  const COLS = 3;
  const ROWS = Math.ceil(cells.length / COLS);

  // Each column is sized to the widest cell it holds, then centred inside its
  // own slot, so the grid stays balanced however large the numbers grow.
  const cellW = (i) =>
    measureText(String(cells[i][0] ?? '—'), VS) + 9 + measureText(cells[i][1], NS);
  const colW = W / COLS;
  const colMax = Array.from({ length: COLS }, (_, c) =>
    Math.max(
      ...Array.from({ length: ROWS }, (_, r) => r * COLS + c)
        .filter((i) => i < cells.length)
        .map(cellW),
    ),
  );

  const gridBottom = top + (ROWS - 1) * pitch + 14;
  const h = gridBottom + 76;

  let b = card(h, t);
  b += heading('BUILD SIGNALS', s.measured ? 'measured via github api' : 'self-reported', t);

  cells.forEach(([value, noun], i) => {
    const y = top + Math.floor(i / COLS) * pitch;
    const x = (i % COLS) * colW + (colW - colMax[i % COLS]) / 2;
    const v = value == null ? '—' : String(value);
    b += text(x, y, v, { size: VS, fill: value == null ? t.faint : t.ink, weight: 700 });
    b += text(x + measureText(v, VS) + 9, y, noun, { size: NS, fill: t.dim });
  });

  b += `<rect x="18" y="${gridBottom}" width="${W - 36}" height="1" fill="${t.line}"/>`;
  b += `<circle cx="22" cy="${gridBottom + 26}" r="4" fill="${t.ok}"/>`;
  b += text(34, gridBottom + 30, 'PUBLIC PROJECTS', {
    size: 10.5, fill: t.ink, weight: 700, spacing: 1.4 });
  b += text(190, gridBottom + 30,
    `${s.activeRepos ?? 0} active · last push ≤ ${s.activeDays ?? CONFIG.activeDays} days`,
    { size: 11, fill: t.dim });
  b += text(18, gridBottom + 54, 'shhh... private builds not included',
    { size: 10.5, fill: t.faint });
  return svg(h, b);
};

const composition = (t, data) => {
  const L = data.languages || { measured: false, items: [] };
  const items = L.items.filter((it) => it.pct != null);
  const cols = CONFIG.legendColumns;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  // Height follows the legend, so adding languages never clips the card.
  const h = 98 + (rows - 1) * 20;

  // Deliberately no repo count: printing it next to the public repos would
  // disclose exactly how many private ones exist.
  let b = text(0, 20, 'CODE COMPOSITION', { size: 11, fill: t.dim, weight: 700, spacing: 1.6 });
  b += text(W, 20,
    !L.measured ? 'self-reported' : L.balanced ? 'measured · balanced across repos' : 'measured',
    { size: 10, fill: t.faint, anchor: 'end', spacing: 1 });

  const total = items.reduce((n, it) => n + it.pct, 0) || 1;
  const color = (it) => it.color || t.dim;

  let x = 0;
  b += `<clipPath id="cb"><rect x="0" y="34" width="${W}" height="14" rx="7"/></clipPath>`;
  b += `<g clip-path="url(#cb)">`;
  for (const it of items) {
    const seg = (it.pct / total) * W;
    b += `<rect x="${x}" y="34" width="${Math.ceil(seg)}" height="14" fill="${color(it)}"/>`;
    x += seg;
  }
  b += `</g>`;

  // Tick labels only where the segment is wide enough to hold one.
  x = 0;
  for (const it of items) {
    const seg = (it.pct / total) * W;
    const abbr = it.name.slice(0, 4).toUpperCase();
    if (seg > measureText(abbr, 9) + 10) {
      b += text(x + seg / 2, 62, abbr, { size: 9, fill: t.faint, anchor: 'middle', spacing: 1 });
    }
    x += seg;
  }

  const cw = W / cols;
  items.forEach((it, i) => {
    const cx = (i % cols) * cw;
    const cy = 84 + Math.floor(i / cols) * 20;
    b += `<circle cx="${cx + 4}" cy="${cy - 4}" r="4" fill="${color(it)}"/>`;
    b += text(cx + 15, cy, it.name, { size: 11.5, fill: t.ink2 });
    b += text(cx + cw - 18, cy, `${it.pct.toFixed(2)}%`, { size: 11, fill: t.faint, anchor: 'end' });
  });

  return svg(h, b);
};

/* ---------------------------------------------------------------- emitter */

const CARDS = { whatibuild, signals, composition };
const dataFile = join(ROOT, 'telemetry.json');

const data = OFFLINE
  ? JSON.parse(readFileSync(dataFile, 'utf8'))
  : await measure();

if (!OFFLINE) writeFileSync(dataFile, JSON.stringify(data, null, 2) + '\n', 'utf8');

for (const [theme, palette] of Object.entries(THEMES)) {
  const dir = theme === 'light' ? join(ROOT, 'assets') : join(ROOT, 'assets', 'dark');
  mkdirSync(dir, { recursive: true });
  for (const [name, draw] of Object.entries(CARDS)) {
    writeFileSync(join(dir, `${name}.svg`), draw(palette, data), 'utf8');
  }
}

const n = Object.keys(CARDS).length * Object.keys(THEMES).length;
console.log(
  OFFLINE
    ? `redrew ${n} svgs from telemetry.json`
    : `measured ${data.signals.commits} commits, ${data.languages.items.length} languages` +
        ` — wrote telemetry.json and ${n} svgs`,
);
