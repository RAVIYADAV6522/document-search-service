// Search page for the document search API. Plain DOM, no framework or build
// step. Document text only ever reaches the page through textContent, never
// innerHTML, so nothing in the data can inject markup.

const PAGE_SIZE = 10;
const SLOW_MS = 2500; // after this, explain that the free server may be waking up
const SUGGESTIONS = ['budget', 'q2', '"latency spike"', 'finance -audit', 'roadmap'];
const ENGINE_LABELS = { sql: 'SQL', cosine: 'Cosine' };
const TAGS_COLLAPSED = 12;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const fmt = (n) => n.toLocaleString('en-US');
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

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
  }
  if ((state.tag || state.q) && state.page) p.set('page', state.page);
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
  const tags = node.querySelector('.card-tags');
  for (const tag of doc.tags) {
    tags.append(el('button', { type: 'button', className: 'tag', textContent: tag, onclick: () => showTag(tag) }));
  }
  return node;
}

function cardList(docs, pattern) {
  if (docs.length === 0) return el('div', { className: 'empty', textContent: 'No documents match.' });
  const frag = document.createDocumentFragment();
  for (const doc of docs) frag.append(card(doc, pattern));
  return frag;
}

function setStatus(...content) {
  $('status').className = 'status';
  $('status').replaceChildren(...content);
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
  for (const row of document.querySelectorAll('.tag-row')) {
    row.setAttribute('aria-pressed', String(row.dataset.tag === state.tag));
  }
}

function runQuery(q) {
  state.q = q;
  state.tag = '';
  state.page = 0;
  run();
}

function welcome() {
  const chips = SUGGESTIONS.map((s) =>
    el('button', { type: 'button', className: 'chip', textContent: s, onclick: () => runQuery(s) }),
  );
  return el('div', { className: 'welcome' }, el('p', { textContent: 'Try a search' }), el('div', { className: 'chips' }, ...chips));
}

// ---- views ----

async function run() {
  writeUrl();
  syncControls();
  inflight?.abort();
  inflight = new AbortController();
  const { signal } = inflight;

  if (!state.q && !state.tag) {
    $('results').replaceChildren(welcome());
    $('pager').hidden = true;
    setStatus();
    return;
  }

  showSkeleton();
  setStatus('Searching…');
  const slow = setTimeout(() => {
    setStatus('Waking up the server, this can take up to a minute…');
  }, SLOW_MS);
  const started = performance.now();

  try {
    let summary;
    if (state.tag) summary = await renderTag(signal);
    else if (state.engine === 'compare') summary = await renderCompare(signal);
    else summary = await renderSearch(signal);
    setStatus(...summary, el('span', { className: 'muted', textContent: ` (${seconds(performance.now() - started)})` }));
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('results').replaceChildren();
    $('pager').hidden = true;
    setStatus(`Something went wrong: ${err.message}`);
    $('status').className = 'status error';
  } finally {
    clearTimeout(slow);
  }
}

async function renderSearch(signal) {
  const params = new URLSearchParams({ q: state.q, engine: state.engine, limit: PAGE_SIZE, offset: state.page * PAGE_SIZE });
  const data = await api(`/search?${params}`, signal);
  $('results').replaceChildren(cardList(data.results, highlightPattern(state.q)));

  const pages = Math.ceil(data.total / PAGE_SIZE);
  $('pager').hidden = pages <= 1;
  $('page-info').textContent = `Page ${fmt(state.page + 1)} of ${fmt(pages)}`;
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page >= pages - 1;
  return [el('strong', { textContent: plural(data.total, 'result') })];
}

async function renderCompare(signal) {
  const query = (engine) => api(`/search?${new URLSearchParams({ q: state.q, engine, limit: PAGE_SIZE })}`, signal);
  const [sql, cosine] = await Promise.all([query('sql'), query('cosine')]);
  const pattern = highlightPattern(state.q);
  const column = (data) =>
    el(
      'div',
      { className: 'column' },
      el('h2', {}, ENGINE_LABELS[data.engine], el('span', { textContent: plural(data.total, 'result') })),
      cardList(data.results, pattern),
    );
  $('results').replaceChildren(el('div', { className: 'columns' }, column(sql), column(cosine)));
  $('pager').hidden = true;
  return [el('strong', { textContent: 'Top 10 from each engine' })];
}

async function renderTag(signal) {
  const params = new URLSearchParams({ tags: state.tag, limit: PAGE_SIZE, offset: state.page * PAGE_SIZE });
  const data = await api(`/documents?${params}`, signal);
  $('results').replaceChildren(cardList(data.results, null));

  const pages = Math.ceil(data.total / PAGE_SIZE);
  $('pager').hidden = pages <= 1;
  $('page-info').textContent = `Page ${fmt(state.page + 1)} of ${fmt(pages)}`;
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page >= pages - 1;
  return [
    el('span', { className: 'tag-pill', textContent: state.tag }),
    ' ',
    el('strong', { textContent: plural(data.total, 'document') }),
    el('button', { type: 'button', className: 'link', textContent: 'Clear', onclick: clearTag }),
  ];
}

function showTag(tag) {
  state.tag = tag;
  state.q = '';
  state.page = 0;
  run();
  $('status').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearTag() {
  state.tag = '';
  state.page = 0;
  run();
}

// ---- sidebar ----

async function loadSidebar() {
  try {
    const [health, stats] = await Promise.all([api('/healthz'), api('/tags/stats')]);
    $('library-meta').textContent = `${plural(health.documents, 'document')} · ${plural(stats.results.length, 'tag')}`;

    const max = Math.max(...stats.results.map((t) => t.document_count), 1);
    const rows = stats.results.map(({ tag, document_count: count }) => {
      const bar = el('span');
      bar.style.width = `${(count / max) * 100}%`;
      const btn = el(
        'button',
        { type: 'button', className: 'tag-row', onclick: () => showTag(tag) },
        el('span', { textContent: tag }),
        el('span', { className: 'tag-count', textContent: fmt(count) }),
        el('span', { className: 'bar' }, bar),
      );
      btn.dataset.tag = tag;
      return el('li', {}, btn);
    });
    const list = $('tag-list');
    list.replaceChildren(...rows.slice(0, TAGS_COLLAPSED));
    if (rows.length > TAGS_COLLAPSED) {
      const more = el('button', { type: 'button', className: 'link', textContent: `Show all ${rows.length}` });
      more.onclick = () => {
        list.replaceChildren(...rows);
        more.remove();
        syncControls();
      };
      list.after(more);
    }
    syncControls();
  } catch {
    $('tag-list').replaceChildren(el('li', { className: 'muted', textContent: 'Could not load tags.' }));
  }
}

// ---- wiring ----

// Search runs on Enter or the Search button, not on every keystroke, so a
// half-typed word never flashes "no matches". Clearing the box resets.
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runQuery($('q').value.trim());
});

$('q').addEventListener('input', () => {
  if ($('q').value === '' && (state.q || state.tag)) runQuery('');
});

$('engine').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-engine]');
  if (!btn) return;
  state.engine = btn.dataset.engine;
  // Use whatever is in the box, even if it hasn't been submitted yet.
  const typed = $('q').value.trim();
  if (typed) runQuery(typed);
  else run();
});

$('prev').addEventListener('click', () => {
  state.page = Math.max(0, state.page - 1);
  run();
  $('status').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('next').addEventListener('click', () => {
  state.page += 1;
  run();
  $('status').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

readUrl();
run();
loadSidebar();
