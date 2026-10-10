// Generates realistic synthetic documents to grow the dataset beyond the 28
// hand-written ones in documents.json. Uses a fixed-seed PRNG, so the same
// arguments always produce exactly the same documents: re-running the seed
// is idempotent, and local and production data match.

// mulberry32: tiny deterministic PRNG returning floats in [0, 1).
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Aarav', 'Meera', 'Daniel', 'Sofia', 'Kenji', 'Fatima', 'Lucas', 'Ananya', 'Oliver', 'Zara',
  'Rohan', 'Chloe', 'Mateo', 'Ishita', 'Noah', 'Leila', 'Arjun', 'Hannah', 'Yusuf', 'Grace'];
const LAST = ['Kapoor', 'Nair', 'Okafor', 'Rossi', 'Tanaka', 'Haddad', 'Silva', 'Iyer', 'Bennett', 'Khan',
  'Mehta', 'Dubois', 'Garcia', 'Banerjee', 'Fischer', 'Rahimi', 'Reddy', 'Novak', 'Aydin', 'Chen'];

const TEAMS = ['Platform', 'Payments', 'Growth', 'Search', 'Mobile', 'Data', 'Infrastructure', 'Checkout', 'Identity', 'Billing'];
const SERVICES = ['checkout-api', 'search-indexer', 'auth-service', 'billing-worker', 'notification-service',
  'ledger-db', 'recommendation-api', 'upload-service', 'reporting-pipeline', 'gateway'];
const VENDORS = ['Acme Cloud', 'Northwind Supplies', 'Globex Analytics', 'Initech Software', 'Umbrella Security',
  'Stark Logistics', 'Wayne Hosting', 'Hooli Ads', 'Vandelay Imports', 'Soylent Catering'];
const PRODUCTS = ['mobile app', 'web dashboard', 'partner API', 'admin console', 'checkout flow', 'search page', 'reporting suite'];
const FEATURES = ['saved searches', 'bulk export', 'two-factor login', 'dark mode', 'usage alerts', 'audit log',
  'role-based access', 'invoice PDFs', 'autocomplete', 'offline mode', 'webhooks', 'tag filters'];
const ROLES = ['Backend Engineer', 'Frontend Engineer', 'Data Analyst', 'Product Designer', 'SRE',
  'Account Executive', 'Support Specialist', 'Security Engineer', 'Product Manager', 'Recruiter'];
const REGIONS = ['India', 'Southeast Asia', 'Europe', 'North America', 'Middle East'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Each topic: tags every document gets, title templates and body sentence
// templates. {slots} are filled from the lists above.
const TOPICS = [
  {
    tags: ['finance', 'budget'],
    titles: ['{Q} {year} Budget Review: {team}', '{team} Budget Variance Report {Q}', 'Annual Budget Proposal {year}: {team}'],
    body: [
      'Reviews {team} spend against the {Q} budget, with variance explained line by line.',
      'Headcount costs came in {pct}% {overunder} plan, mainly driven by contractor spend.',
      'Infrastructure costs for {service} grew {pct}% quarter over quarter.',
      'Includes a proposal to reallocate budget toward {feature} for the {product}.',
    ],
  },
  {
    tags: ['finance', 'audit'],
    titles: ['{vendor} Invoice Reconciliation {month} {year}', '{Q} Finance Audit Notes: {team}', 'Vendor Payment Review: {vendor}'],
    body: [
      'Reconciles {n} invoices from {vendor} against purchase orders for {month}.',
      'Flags {n} duplicate payments and one missing approval for review by the finance team.',
      'Audit sample covered expense reports, vendor payments and accruals for {Q}.',
      'Recommends stricter approval thresholds for payments above the quarterly limit.',
    ],
  },
  {
    tags: ['engineering', 'incident', 'postmortem'],
    titles: ['Postmortem: {service} Outage on {month} {day}', 'Incident Review: {service} Latency Spike', 'Postmortem: Failed Deploy of {service}'],
    body: [
      '{service} returned errors for {n} minutes after a configuration change was rolled out.',
      'Root cause was a missing index that made a hot query scan the full table.',
      'Latency at the 99th percentile rose to {ms} ms before the rollback completed.',
      'Action items include adding an alert on error rate and a canary stage for {service}.',
    ],
  },
  {
    tags: ['engineering', 'backend', 'database'],
    titles: ['Migration Plan: {service} to Postgres 16', 'Database Index Review for {service}', 'Schema Change Proposal: {feature}'],
    body: [
      'Proposes moving {service} to a managed Postgres cluster with read replicas.',
      'EXPLAIN output shows a sequential scan on the orders table; a composite index fixes it.',
      'The migration runs in {n} phases with dual writes and a verification job.',
      'Rollback plan keeps the old database writable until verification passes.',
    ],
  },
  {
    tags: ['engineering', 'search', 'ranking'],
    titles: ['Search Relevance Experiment #{n}', 'Query Latency Report for search-indexer', 'Ranking Change Proposal: {feature}'],
    body: [
      'Compares cosine similarity ranking against full-text search on {n} sampled queries.',
      'Click-through on the first result improved {pct}% with title terms weighted higher.',
      'Search latency stayed under {ms} ms at the 95th percentile after the index rebuild.',
      'Next step is to add stemming so plural queries match singular document terms.',
    ],
  },
  {
    tags: ['product', 'roadmap', 'planning'],
    titles: ['{Q} {year} Product Roadmap: {product}', 'Feature Spec: {feature}', 'Product Requirements: {feature} for the {product}'],
    body: [
      'Outlines the {Q} plan for the {product}, led by the {team} team.',
      'The top priority is {feature}, requested by {n} enterprise customers.',
      'Success is measured by weekly active usage and support ticket volume.',
      'Open questions cover pricing, rollout order by region and API changes for partners.',
    ],
  },
  {
    tags: ['hr', 'planning'],
    titles: ['{Q} {year} Hiring Plan: {team}', 'Interview Loop for {role}', 'Onboarding Guide for New {role}s'],
    body: [
      'Plans {n} new hires for the {team} team in {Q}, starting with a {role}.',
      'Each candidate goes through a screening call, a technical round and a team interview.',
      'New joiners get a buddy, a 30-60-90 day plan and access requests on day one.',
      'Includes the salary bands approved by finance for {year}.',
    ],
  },
  {
    tags: ['security', 'compliance'],
    titles: ['Security Review: {service}', 'Access Review {Q} {year}', 'Penetration Test Findings: {product}'],
    body: [
      'Reviews authentication and secrets handling in {service} before the {Q} release.',
      'Found {n} medium-severity issues; none were exploitable from outside the network.',
      'All production access now requires two-factor login and expires after 90 days.',
      'Compliance evidence was collected for the annual audit by {vendor}.',
    ],
  },
  {
    tags: ['legal', 'policy', 'compliance'],
    titles: ['{topic} Policy Update {year}', 'Contract Review: {vendor}', 'Data Retention Policy for {product}'],
    body: [
      'Updates the {topic} policy to reflect new requirements in {region}.',
      'The {vendor} contract renews in {month}; legal recommends renegotiating the liability cap.',
      'Customer data is deleted {n} days after account closure unless legally required.',
      'Every team lead must confirm they have read the policy by the end of {Q}.',
    ],
  },
  {
    tags: ['sales', 'playbook'],
    titles: ['{Q} Sales Playbook: {region}', 'Deal Review: {vendor} Renewal', 'Pricing Proposal for {product}'],
    body: [
      'Targets mid-market accounts in {region} with the {product} as the lead offer.',
      'Pipeline for {Q} stands at {n} qualified deals, {pct}% above last quarter.',
      'Discounts above {pct}% need approval from the regional sales director.',
      'Common objections are pricing and data residency; answers are included below.',
    ],
  },
  {
    tags: ['marketing', 'review'],
    titles: ['Campaign Retrospective: {feature} Launch', '{month} {year} Marketing Report', 'Content Plan {Q}: {product}'],
    body: [
      'The {feature} launch campaign reached {n} thousand people across email and social.',
      'Conversion from trial to paid improved {pct}% for users who saw the onboarding video.',
      'Paid ads spend with {vendor} was cut after low click-through in {region}.',
      'Next quarter focuses on case studies and webinars for the {product}.',
    ],
  },
  {
    tags: ['design', 'frontend'],
    titles: ['Design Review: {feature}', 'Component Library Update {month} {year}', 'Usability Study: {product}'],
    body: [
      'Presents three layouts for {feature} in the {product}, with the trade-offs of each.',
      'Usability testing with {n} participants found the filter controls hard to discover.',
      'New components include a date picker, toast messages and an empty state.',
      'All designs meet colour-contrast guidelines in light and dark mode.',
    ],
  },
  {
    tags: ['onboarding', 'playbook'],
    titles: ['Customer Onboarding Playbook: {product}', 'Support Runbook: {service} Errors', 'Customer Health Review {Q}'],
    body: [
      'Walks new customers through setup of the {product} in their first {n} days.',
      'Support tickets about {feature} dropped {pct}% after the in-app guide shipped.',
      'Escalations for {service} errors go to the on-call engineer within 15 minutes.',
      'Accounts with low usage get a check-in call from customer success.',
    ],
  },
];
const POLICY_TOPICS = ['Remote Work', 'Travel and Expense', 'Information Security', 'Data Privacy', 'Procurement', 'Code of Conduct'];

const pad = (n, w) => String(n).padStart(w, '0');

// Owners own-6 .. own-(5 + extraOwners). own-1..own-5 come from
// documents.json; own-5 deliberately keeps zero documents.
export function generateOwners(extraOwners = 20, { seed = 7 } = {}) {
  const rand = prng(seed);
  const used = new Set();
  const owners = [];
  for (let i = 0; i < extraOwners; i++) {
    let name;
    do {
      name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    } while (used.has(name));
    used.add(name);
    const id = `own-${i + 6}`;
    owners.push({ id, name, email: `${name.toLowerCase().replace(' ', '.')}@example.com` });
  }
  return owners;
}

// count documents with ids doc-00029 onward (the hand-written ones are
// doc-001..doc-028, so the ids can't collide), owned by own-1..own-4 and the
// generated owners, created between 2024-01-01 and 2026-09-30.
export function generateDocuments(count, ownerIds, { seed = 42 } = {}) {
  const rand = prng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const START = Date.parse('2024-01-01T00:00:00Z');
  const END = Date.parse('2026-09-30T23:59:59Z');

  const docs = [];
  for (let i = 0; i < count; i++) {
    const topic = pick(TOPICS);
    const created = new Date(START + Math.floor(rand() * (END - START)));
    created.setUTCSeconds(0, 0);
    const year = created.getUTCFullYear();
    const quarter = Math.floor(created.getUTCMonth() / 3) + 1;
    const slots = {
      Q: `Q${quarter}`,
      year,
      month: MONTHS[created.getUTCMonth()],
      day: created.getUTCDate(),
      team: pick(TEAMS),
      service: pick(SERVICES),
      vendor: pick(VENDORS),
      product: pick(PRODUCTS),
      feature: pick(FEATURES),
      role: pick(ROLES),
      region: pick(REGIONS),
      topic: pick(POLICY_TOPICS),
      overunder: rand() < 0.5 ? 'over' : 'under',
    };
    const fill = (template) =>
      template.replace(/\{(\w+)\}/g, (_, key) => {
        if (key === 'n') return String(int(2, 40));
        if (key === 'pct') return String(int(3, 35));
        if (key === 'ms') return String(int(80, 900));
        return String(slots[key]);
      });

    // Two or three of the topic's sentences, in their original order.
    let sentences = topic.body.filter(() => rand() < 0.7);
    if (sentences.length < 2) sentences = topic.body.slice(0, 2);

    const title = fill(pick(topic.titles));
    const tags = [...topic.tags];
    // Tag the quarter when the title names it, as the hand-written data does.
    if (title.includes(slots.Q)) tags.push(slots.Q.toLowerCase());

    docs.push({
      id: `doc-${pad(i + 29, 5)}`,
      title,
      body: sentences.map(fill).join(' '),
      owner: pick(ownerIds),
      tags,
      created: created.toISOString().replace('.000Z', 'Z'),
    });
  }
  return docs;
}

// The full dataset: the hand-written base plus generated owners and enough
// generated documents to reach `total`.
export function expandDataset(base, total) {
  const extra = Math.max(0, total - base.documents.length);
  if (extra === 0) return base;
  const owners = [...base.owners, ...generateOwners()];
  const ownerIds = owners.map((o) => o.id).filter((id) => id !== 'own-5');
  return { owners, documents: [...base.documents, ...generateDocuments(extra, ownerIds)] };
}
