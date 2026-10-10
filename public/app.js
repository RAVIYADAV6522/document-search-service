// Search page for the document search API. Plain DOM, no framework or build
// step. Document text only ever reaches the page through textContent, never
// innerHTML, so nothing in the data can inject markup.

const PAGE_SIZE = 10;
const SLOW_MS = 2500; // after this, explain that the free server may be waking up
const SUGGESTIONS = ['budget', 'search ranking', '"latency spike"', 'finance -audit', 'roadmap', 'budgets'];
const ENGINE_HINTS = {
  sql: 'Matches every word, understands word forms ("budgets" finds "budget"), skips stop words, supports "phrases" and -exclusions.',
  cosine: 'Matches any word exactly and scores by cosine similarity of word counts. Written from scratch in JavaScript.',
  compare: 'Runs both engines on the same query so you can see where they agree and differ.',
};
const ENGINE_LABELS = { sql: 'PostgreSQL full-text', cosine: 'Cosine (from scratch)' };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const state = { q: '', engine: 'sql', page: 0, tag: '' };
let inflight = null;

// ---- URL state, so every view has a shareable link ----

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') ?? '';
  state.engine = ['sql', 'cosine', 'compare'].includes(p.get('engine')) ? p.get('engine') : 'sql';
  state.page = Math.max(0, Number.parseInt(p.get('page'), 10) || 0);
  state.tag = p.get('tag') ?? '';
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.tag) p.set('tag', state.tag);
  else if (state.q) {
    p.set('q', state.q);
    p.set('engine', state.engine);
    if (state.page) p.set('page', state.page);
  }
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ---- API ----

async function api(path, signal) {
  const res = await fetch(path, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

// ---- rendering helpers ----

// Rough word stems for highlighting: Postgres matches "budgets" to
// "budget", so highlight words that share a stem with a query word.
function highlightPattern(query) {
  const stems = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-') && w !== 'or')
    .flatMap((w) => w.split(/[^a-z0-9]+/))
    .filter((w) => w.length >= 2)
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w));
  if (stems.length === 0) return null;
  const escaped = [...new Set(stems)].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})[a-z0-9]*`, 'gi');
}

function highlighted(text, pattern) {
  const frag = document.createDocumentFragment();
  if (!pattern) {
    frag.append(text);
    return frag;
  }
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    frag.append(text.slice(last, m.index), el('mark', { textContent: m[0] }));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function card(doc, pattern) {
  const node = $('card-template').content.firstElementChild.cloneNode(true);
  node.querySelector('.card-title').append(highlighted(doc.title, pattern));
  node.querySelector('.card-body').append(highlighted(doc.body, pattern));
  const score = node.querySelector('.score');
  if (typeof doc.score === 'number') score.textContent = doc.score.toFixed(3);
  else score.remove();
  node.querySelector('.owner').textContent = doc.owner_name ?? doc.owner;
  const time = node.querySelector('.date');
  time.dateTime = doc.created;
  time.textContent = dateFormat.format(new Date(doc.created));
  node.querySelector('.doc-id').textContent = doc.id;
  const tags = node.querySelector('.card-tags');
  for (const tag of doc.tags) {
    tags.append(el('button', { type: 'button', className: 'tag', textContent: `#${tag}`, onclick: () => showTag(tag) }));
  }
  return node;
}

function cardList(docs, pattern) {
  if (docs.length === 0) {
    return el('div', { className: 'empty', textContent: 'No documents match. Try another word, or switch engine.' });
  }
  const frag = document.createDocumentFragment();
  for (const doc of docs) frag.append(card(doc, pattern));
  return frag;
}

function setStatus(content, isError = false) {
  const status = $('status');
  status.className = isError ? 'status error' : 'status';
  status.replaceChildren(...[content].flat());
}

function setStats({ matches = '–', ms = null } = {}) {
  $('stat-matches').textContent = matches;
  $('stat-time').textContent = ms === null ? '–' : `${ms} ms`;
}

function showSkeleton(count = 3) {
  $('results').replaceChildren(...Array.from({ length: count }, () => el('div', { className: 'skeleton' })));
  $('pager').hidden = true;
}

function syncControls() {
  $('q').value = state.q;
  for (const btn of $('engine').querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.engine === state.engine));
  }
  $('engine-hint').textContent = ENGINE_HINTS[state.engine];
  for (const row of document.querySelectorAll('.tag-row')) {
    row.setAttribute('aria-pressed', String(row.dataset.tag === state.tag));
  }
}

// ---- views ----

async function run() {
  writeUrl();
  syncControls();
  inflight?.abort();
  inflight = new AbortController();
  const { signal } = inflight;

  if (!state.q && !state.tag) {
    $('results').replaceChildren(
      el('div', { className: 'empty' }, 'Type a keyword above, pick a suggestion, or click a tag to browse.'),
    );
    $('pager').hidden = true;
    setStatus('');
    setStats();
    return;
  }

  showSkeleton();
  setStatus('Searching…');
  const slow = setTimeout(() => {
    setStatus('Waking up the server (free hosting sleeps when idle). This can take up to a minute the first time…');
  }, SLOW_MS);
  const started = performance.now();

  try {
    if (state.tag) await renderTag(signal);
    else if (state.engine === 'compare') await renderCompare(signal);
    else await renderSearch(signal);
    setStats({ ...lastStats, ms: Math.round(performance.now() - started) });
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('results').replaceChildren();
    $('pager').hidden = true;
    setStatus(`Something went wrong: ${err.message}`, true);
    setStats();
  } finally {
    clearTimeout(slow);
  }
}

let lastStats = {};

async function renderSearch(signal) {
  const params = new URLSearchParams({ q: state.q, engine: state.engine, limit: PAGE_SIZE, offset: state.page * PAGE_SIZE });
  const data = await api(`/search?${params}`, signal);
  lastStats = { matches: data.total };

  const from = data.total === 0 ? 0 : data.offset + 1;
  const to = data.offset + data.results.length;
  setStatus([
    el('strong', { textContent: `${data.total} ${data.total === 1 ? 'match' : 'matches'}` }),
    ` for “${data.query}” · ${ENGINE_LABELS[data.engine]}`,
    data.total > PAGE_SIZE ? ` · showing ${from}–${to}` : '',
  ]);
  $('results').replaceChildren(cardList(data.results, highlightPattern(state.q)));

  const pages = Math.ceil(data.total / PAGE_SIZE);
  $('pager').hidden = pages <= 1;
  $('page-info').textContent = `Page ${state.page + 1} of ${pages}`;
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page >= pages - 1;
}

async function renderCompare(signal) {
  const query = (engine) =>
    api(`/search?${new URLSearchParams({ q: state.q, engine, limit: PAGE_SIZE })}`, signal);
  const [sql, cosine] = await Promise.all([query('sql'), query('cosine')]);
  lastStats = { matches: `${sql.total} / ${cosine.total}` };

  const pattern = highlightPattern(state.q);
  const column = (data) =>
    el(
      'div',
      { className: 'column' },
      el('h2', {}, ENGINE_LABELS[data.engine], el('span', { textContent: `${data.total} matches` })),
      cardList(data.results, pattern),
    );
  setStatus([
    el('strong', { textContent: 'Comparing engines' }),
    ` for “${state.q}”: top ${PAGE_SIZE} from each.`,
  ]);
  $('results').replaceChildren(el('div', { className: 'columns' }, column(sql), column(cosine)));
  $('pager').hidden = true;
}

async function renderTag(signal) {
  const data = await api(`/documents?${new URLSearchParams({ tags: state.tag })}`, signal);
  lastStats = { matches: data.total };
  setStatus([
    el('strong', { textContent: `${data.total} ${data.total === 1 ? 'document' : 'documents'}` }),
    ' tagged ',
    el('code', { textContent: `#${state.tag}` }),
    ', newest first · ',
    el('button', { type: 'button', className: 'show-more', textContent: 'Clear filter', onclick: clearTag }),
  ]);
  $('results').replaceChildren(cardList(data.results, null));
  $('pager').hidden = true;
}

function showTag(tag) {
  state.tag = tag;
  state.q = '';
  state.page = 0;
  run();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearTag() {
  state.tag = '';
  run();
}

// ---- sidebar ----

async function loadSidebar() {
  try {
    const [health, stats, inactive] = await Promise.all([
      api('/healthz'),
      api('/tags/stats'),
      api('/owners/inactive'),
    ]);
    $('stat-docs').textContent = health.documents;
    $('stat-tags').textContent = stats.results.length;

    const max = Math.max(...stats.results.map((t) => t.document_count), 1);
    const rows = stats.results.map(({ tag, document_count: count }) => {
      const bar = el('span');
      bar.style.width = `${(count / max) * 100}%`;
      const btn = el(
        'button',
        { type: 'button', className: 'tag-row', onclick: () => showTag(tag) },
        el('span', { textContent: `#${tag}` }),
        el('span', { className: 'tag-count', textContent: count }),
        el('span', { className: 'bar' }, bar),
      );
      btn.dataset.tag = tag;
      return el('li', {}, btn);
    });
    const list = $('tag-list');
    const COLLAPSED = 10;
    list.replaceChildren(...rows.slice(0, COLLAPSED));
    if (rows.length > COLLAPSED) {
      const more = el('button', { type: 'button', className: 'show-more', textContent: `Show all ${rows.length} tags` });
      more.onclick = () => {
        list.replaceChildren(...rows);
        more.remove();
      };
      list.after(more);
    }

    $('inactive-owners').replaceChildren(
      ...(inactive.results.length
        ? inactive.results.map((o) => el('li', {}, o.name, el('small', { textContent: `${o.id} · ${o.email}` })))
        : [el('li', { textContent: 'Every owner has at least one document.' })]),
    );
    syncControls();
  } catch {
    $('tag-list').replaceChildren(el('li', { className: 'panel-note', textContent: 'Could not load tags.' }));
  }
}

// ---- wiring ----

let debounce;
$('q').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.q = $('q').value.trim();
    state.tag = '';
    state.page = 0;
    run();
  }, 300);
});

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(debounce);
  state.q = $('q').value.trim();
  state.tag = '';
  state.page = 0;
  run();
});

$('engine').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-engine]');
  if (!btn) return;
  state.engine = btn.dataset.engine;
  state.page = 0;
  if (state.tag) state.tag = '';
  run();
});

$('prev').addEventListener('click', () => {
  state.page = Math.max(0, state.page - 1);
  run();
});
$('next').addEventListener('click', () => {
  state.page += 1;
  run();
});

for (const s of SUGGESTIONS) {
  $('suggestions').append(
    el('button', {
      type: 'button',
      textContent: s,
      onclick: () => {
        state.q = s;
        state.tag = '';
        state.page = 0;
        run();
      },
    }),
  );
}

readUrl();
run();
loadSidebar();
