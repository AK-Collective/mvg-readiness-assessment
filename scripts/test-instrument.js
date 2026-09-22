#!/usr/bin/env node
/* =========================================================================
   MVG Readiness Assessment — portable test battery
   Implements Phase H of instrument-design-SOP.md.

   The harness LIFTS THE REAL index.html and runs the shipped scoring code in
   a vm with a stubbed DOM. There is no second copy of the scoring logic here,
   so the tests cannot pass while production drifts away from them. If the
   file is restructured and loadApp() stops matching, FIX THE PATTERN — do not
   delete the test.
   ========================================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { pass++; }
    else { fail++; failures.push(name + ' — ' + r); }
  } catch (e) {
    fail++; failures.push(name + ' — threw: ' + e.message);
  }
}

/* ------------------------------------------------------- lift the real app */

function loadApp() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error('could not locate the app <script> block in index.html');

  // Elements are cached by id so a write in the app is readable by a test.
  // createElement stays uncached: those are throwaway nodes, and sharing one
  // would make every appended item the same object.
  const registry = {};
  const makeNode = id => ({
    id: id || '', style: {}, classList: { add(){}, remove(){}, toggle(){} },
    children: [], textContent: '', innerHTML: '', value: '', hidden: false,
    appendChild(c){ this.children.push(c); }, addEventListener(){},
    removeAttribute(){}, setAttribute(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    scrollIntoView(){}, closest(){ return null; }
  });
  const el = id => {
    if (id === undefined || id === null) return makeNode('');
    if (!registry[id]) registry[id] = makeNode(id);
    return registry[id];
  };
  const sandbox = {
    document: {
      getElementById: id => el(id),
      createElement: () => el(null),
      querySelector: () => el('__q'),
      querySelectorAll: () => [], addEventListener(){}
    },
    // The app now registers popstate/beforeunload handlers and reads history at
    // boot. Stub them so the harness keeps lifting the REAL file.
    window: { print(){}, scrollTo(){}, addEventListener(){} },
    history: { pushState(){}, length: 1 },
    CSS: { escape: x => x },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setTimeout(){}, console,
    module: { exports: {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: 'index.html:app' });
  if (!sandbox.module.exports.scoreAll) {
    throw new Error('index.html did not export scoreAll — check the module.exports line at the end of the app script');
  }
  sandbox.module.exports.__dom = registry;
  return sandbox.module.exports;
}

const app = loadApp();
const DOM = app.__dom;

// Strip tags and collapse entities so a word count measures prose, not markup.
function words(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .split(/\s+/).filter(Boolean).length;
}

// Pull the inner HTML of every element carrying `cls`, matching close tags by
// depth so nested inline markup is kept. Deliberately written with plain string
// scanning: an earlier regex version lost its escapes in transit and silently
// matched nothing, which would have made every copy budget pass vacuously.
function blocks(html, cls) {
  const s = String(html || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '<' || s[i + 1] === '/') continue;
    const gt = s.indexOf('>', i);
    if (gt === -1) break;
    const head = s.slice(i + 1, gt);
    const tag = head.split(/[\s>]/)[0].toLowerCase();
    if (!tag) continue;
    const cm = head.match(/class="([^"]*)"/i);
    if (!cm || cm[1].split(/\s+/).indexOf(cls) === -1) { i = gt; continue; }
    // walk forward tracking depth of this tag name
    let depth = 1, j = gt + 1, start = gt + 1;
    while (j < s.length && depth > 0) {
      const nextOpen = s.indexOf('<' + tag, j);
      const nextClose = s.indexOf('</' + tag, j);
      if (nextClose === -1) { j = s.length; break; }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const after = s[nextOpen + 1 + tag.length];
        if (after === '>' || after === ' ') depth++;
        j = nextOpen + 1;
      } else {
        depth--;
        j = nextClose + 1;
        if (depth === 0) { out.push(s.slice(start, nextClose)); }
      }
    }
    i = gt;
  }
  return out;
}

const { COMPONENTS, SCALE, COMPONENT_BANDS, OVERALL_BANDS, COMPONENT_ACTIONS, LAYER_PATTERNS, LAYER_NAMES,
        INSTRUMENT_VERSION, SCREENS, REVIEW_STEP, RESULTS_STEP, STORAGE_KEY,
        HOLD, MIN_ITEMS_SCORED, COVERAGE_FLOOR,
        answers, scoreAll, fractureCopy, actionFor, layerSignature, patternFor } = app;

const ALL_ITEMS = COMPONENTS.flatMap(c => c.items);

function setAll(fn) {
  Object.keys(answers).forEach(k => delete answers[k]);
  COMPONENTS.forEach((c, ci) => c.items.forEach((item, ii) => {
    const a = fn(c, item, ci, ii);
    if (a !== undefined) answers[item.id] = a;
  }));
}
const val = v => ({ v, dk: false, na: false });
const DK = { v: null, dk: true, na: false };
const NA = { v: null, dk: false, na: true };

// mulberry32. A textbook LCG (seed * 1103515245 + 12345) & 0x7fffffff is WRONG
// in JS: the multiply exceeds 2^53, float rounding destroys exactly the low
// bits the mask keeps, and the sequence collapses to 0 within two draws. That
// makes a "20,000 iteration fuzz" run one response set 20,000 times and pass
// vacuously. Any PRNG here must use Math.imul.
function makeRnd(seed) {
  let s = seed >>> 0;
  return function (n) {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

t('HARNESS · the PRNG actually varies (guards against vacuous fuzzing)', () => {
  const r = makeRnd(1);
  const draws = new Set();
  for (let i = 0; i < 200; i++) draws.add(r(4));
  return draws.size === 4 || 'PRNG produced only ' + draws.size + ' distinct values in 200 draws';
});

/* ---------------------------------------------------------- BAND COVERAGE */

t('BAND COVERAGE · every component percentage lands in exactly one band', () => {
  for (let p = 0; p <= 100; p += 0.5) {
    const hits = COMPONENT_BANDS.filter(b => p >= b.min);
    if (hits.length === 0) return 'no band matches ' + p + '%';
    if (COMPONENT_BANDS.find(b => p >= b.min) !== hits[0]) return 'band selection ambiguous at ' + p + '%';
  }
  return true;
});

t('BAND COVERAGE · component bands are gapless and descending', () => {
  for (let i = 1; i < COMPONENT_BANDS.length; i++) {
    if (COMPONENT_BANDS[i].min >= COMPONENT_BANDS[i - 1].min) return 'bands not strictly descending at index ' + i;
  }
  return COMPONENT_BANDS[COMPONENT_BANDS.length - 1].min === 0 || 'lowest band does not reach 0';
});

t('BAND COVERAGE · every overall percentage lands in exactly one band', () => {
  for (let p = 0; p <= 100; p += 0.5) {
    const hit = [...OVERALL_BANDS].reverse().find(b => p >= b.min);
    if (!hit) return 'no overall band matches ' + p + '%';
  }
  return true;
});

t('BAND COVERAGE · overall band ranks are unique and contiguous from 0', () => {
  const ranks = OVERALL_BANDS.map(b => b.rank).sort((a, b) => a - b);
  return ranks.every((r, i) => r === i) || 'ranks are ' + ranks.join(',');
});

/* ------------------------------------------ HEADLINE/COMPONENT CONSISTENCY */
/* The defect this instrument exists to prevent: a headline claiming more than
   the ladder supports. v1 printed "all five components are operating" above a
   fracture bar. Fuzzed, because it is a cross-component interaction. */

t('CONSISTENCY · the v1 defect case (four strong, one below hold) is capped', () => {
  setAll((c, item, ci) => val(ci === 4 ? 1 : 3));
  const s = scoreAll();
  if (!s.firstBreak) return 'expected a break with one component at 33%';
  if (s.overall.band === 'Floor in place') return 'headline still claims "Floor in place" while a component does not hold';
  return s.capped === true || 'expected the headline to be flagged as ladder-capped';
});

t('CONSISTENCY · fuzz 20000 response sets — headline never outranks the ladder cap', () => {
  const rnd = makeRnd(12345);
  for (let i = 0; i < 20000; i++) {
    setAll(() => val(rnd(4)));
    const s = scoreAll();
    if (s.insufficientOverall) continue;
    const capRank = !s.firstBreak ? 3
      : (s.firstBreak.component.tier === 1 ? 0 : s.firstBreak.component.tier === 2 ? 1 : 2);
    if (s.overall.rank > capRank) {
      return 'iteration ' + i + ': headline rank ' + s.overall.rank + ' exceeds ladder cap ' + capRank;
    }
    if (!s.firstBreak && s.overall.rank !== 3 && s.compensatory >= 80) {
      return 'iteration ' + i + ': all components hold but headline is ' + s.overall.band;
    }
  }
  return true;
});

t('CONSISTENCY · "Floor in place" is unreachable while any component fails', () => {
  const rnd = makeRnd(999);
  for (let i = 0; i < 5000; i++) {
    setAll(() => val(rnd(4)));
    const s = scoreAll();
    if (s.overall.band === 'Floor in place' && s.results.some(r => !r.holds)) {
      return 'iteration ' + i + ': "Floor in place" with a non-holding component';
    }
  }
  return true;
});

/* -------------------------------------------------------------- DK and N/A */

t('DK · never enters the numerator or the denominator', () => {
  setAll(() => val(3));
  const full = scoreAll().results[0];
  setAll((c, item, ii) => (c.id === 'c01' && item.id === 'c01.5') ? DK : val(3));
  const withDk = scoreAll().results[0];
  if (withDk.pct !== full.pct) return 'DK changed the percentage from ' + full.pct + ' to ' + withDk.pct;
  if (withDk.scored !== 4) return 'expected 4 scored items, got ' + withDk.scored;
  if (withDk.applicable !== 5) return 'DK must remain applicable; got ' + withDk.applicable;
  return true;
});

t('DK · reduces coverage while N/A does not', () => {
  setAll((c, item) => item.id === 'c01.5' ? DK : val(3));
  const dkCov = scoreAll().results[0].coverage;
  setAll((c, item) => item.id === 'c01.5' ? NA : val(3));
  const naCov = scoreAll().results[0].coverage;
  if (dkCov >= 1) return 'DK did not reduce coverage (' + dkCov + ')';
  if (naCov !== 1) return 'N/A reduced coverage (' + naCov + '), it should not';
  return true;
});

t('DK · never clears a gate — an all-DK component cannot hold', () => {
  setAll(c => c.id === 'c01' ? DK : val(3));
  const s = scoreAll();
  const c01 = s.results.find(r => r.component.id === 'c01');
  if (c01.holds) return 'a component with no assessable evidence reported as load-bearing';
  if (!c01.insufficient) return 'expected insufficient evidence';
  if (c01.band.label === 'Absent') return 'unassessed component mislabelled "Absent" — it is unknown, not empty';
  return s.firstBreak && s.firstBreak.component.id === 'c01' || 'unassessed foundation did not become the focus';
});

t('DK · a component drops below the item floor at fewer than 3 scored items', () => {
  setAll((c, item, ci, ii) => (c.id === 'c01' && ii >= MIN_ITEMS_SCORED - 1) ? DK : val(3));
  const c01 = scoreAll().results.find(r => r.component.id === 'c01');
  return c01.insufficient === true || 'expected insufficient at ' + c01.scored + ' scored items';
});

t('N/A · removes the item from its component entirely', () => {
  setAll((c, item) => item.id === 'c04.2' ? NA : val(0));
  const c04 = scoreAll().results.find(r => r.component.id === 'c04');
  if (c04.applicable !== 4) return 'expected 4 applicable items, got ' + c04.applicable;
  if (c04.na !== 1) return 'expected 1 n/a, got ' + c04.na;
  return true;
});

/* --------------------------------------------------------- COVERAGE FLOOR */

t('COVERAGE · no overall band is issued below the two-thirds floor', () => {
  let i = 0;
  setAll(() => (i++ % 3 === 0) ? val(3) : DK);   // ~1/3 coverage
  const s = scoreAll();
  if (!s.insufficientOverall) return 'issued a band at coverage ' + s.coverage;
  return true;
});

t('COVERAGE · a band IS issued at full coverage', () => {
  setAll(() => val(2));
  const s = scoreAll();
  return s.insufficientOverall === false || 'withheld a band at full coverage';
});

t('COVERAGE · the floor constant matches what the copy promises', () => {
  return Math.abs(COVERAGE_FLOOR - 2 / 3) < 1e-9 || 'COVERAGE_FLOOR is ' + COVERAGE_FLOOR;
});

/* --------------------------------------------------------- SELECTION ORDER */
/* Gated model: the recommendation is the first unmet prerequisite in BUILD
   order, which is frequently NOT the lowest score. This test fails if anyone
   "helpfully" re-sorts by score. */

t('SELECTION · focus is the first break in build order, not the lowest score', () => {
  // c01 (First) just below hold; c04 (Third) far worse.
  setAll((c, item, ci, ii) => {
    if (c.id === 'c01') return val(ii < 2 ? 2 : 1);   // ~46%
    if (c.id === 'c04') return val(0);                // 0%
    return val(3);
  });
  const s = scoreAll();
  if (!s.firstBreak) return 'expected a break';
  if (s.firstBreak.component.id !== 'c01') {
    return 'focus was ' + s.firstBreak.component.id + ' (lowest score) rather than c01 (first in build order)';
  }
  const lowest = [...s.results].sort((a, b) => a.pct - b.pct)[0];
  return lowest.component.id === 'c04' || 'test fixture no longer distinguishes the two orders';
});

t('SELECTION · build order is the array order and starts at tier 1', () => {
  const tiers = COMPONENTS.map(c => c.tier);
  for (let i = 1; i < tiers.length; i++) if (tiers[i] < tiers[i - 1]) return 'tiers not non-decreasing: ' + tiers.join(',');
  return tiers[0] === 1 || 'first component is not tier 1';
});

t('SELECTION · a lower-tier break outranks a higher-tier one in the cap', () => {
  setAll(c => val(c.tier === 1 ? 0 : 3));
  const a = scoreAll();
  setAll(c => val(c.tier === 3 ? 0 : 3));
  const b = scoreAll();
  return a.overall.rank < b.overall.rank || 'a foundation failure was not penalised more than an upper-layer failure';
});

/* ------------------------------------------------------------- ITEM SHAPE */

t('ITEMS · ids are unique across the whole instrument', () => {
  const ids = ALL_ITEMS.map(i => i.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  return dupes.length === 0 || 'duplicate ids: ' + [...new Set(dupes)].join(', ');
});

t('ITEMS · ids are stable strings, never array positions', () => {
  return ALL_ITEMS.every(i => typeof i.id === 'string' && /^c\d{2}\.\d+$/.test(i.id))
    || 'an item id does not match the stable cNN.N pattern';
});

t('ITEMS · every component clears the 3-item reporting floor', () => {
  const thin = COMPONENTS.filter(c => c.items.length < MIN_ITEMS_SCORED);
  return thin.length === 0 || 'too few items in: ' + thin.map(c => c.num).join(', ');
});

t('ITEMS · no two stems are near-duplicates across components', () => {
  const norm = s => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 4);
  for (let i = 0; i < ALL_ITEMS.length; i++) {
    for (let j = i + 1; j < ALL_ITEMS.length; j++) {
      const a = new Set(norm(ALL_ITEMS[i].stem)), b = norm(ALL_ITEMS[j].stem);
      const overlap = b.filter(w => a.has(w)).length / Math.max(a.size, b.length);
      if (overlap > 0.6) return ALL_ITEMS[i].id + ' and ' + ALL_ITEMS[j].id + ' overlap ' + Math.round(overlap * 100) + '%';
    }
  }
  return true;
});

/* --------------------------------------------------------- ITEM STRUCTURE */
/* Items are a question stem plus four item-specific descriptions. The option
   INDEX is the score, so the option count and the scored scale length must
   agree or every answer is mis-scored with no error. */

t('STEMS · every item asks a question rather than asserting a statement', () => {
  const bad = ALL_ITEMS.filter(i => !i.stem || !i.stem.trim().endsWith('?'));
  return bad.length === 0
    || 'declarative stems (a maturity ladder cannot answer these grammatically): ' + bad.map(i => i.id).join(', ');
});

t('OPTIONS · every item carries exactly as many options as there are scored scale points', () => {
  const scored = SCALE.filter(o => !o.dk && !o.na).length;
  const bad = ALL_ITEMS.filter(i => !Array.isArray(i.options) || i.options.length !== scored);
  return bad.length === 0
    || 'option count disagrees with the ' + scored + '-point scale at: ' +
       bad.map(i => i.id + '(' + (i.options ? i.options.length : 'none') + ')').join(', ');
});

t('OPTIONS · no option is empty, placeholder, or trivially short', () => {
  const bad = [];
  ALL_ITEMS.forEach(i => (i.options || []).forEach((o, n) => {
    if (!o || !o.trim() || o.trim().length < 15 || /\bTODO\b|\bTBD\b|Lorem/i.test(o)) bad.push(i.id + '[' + n + ']');
  }));
  return bad.length === 0 || 'weak option copy at: ' + bad.join(', ');
});

t('OPTIONS · the options within an item are all distinct', () => {
  const bad = ALL_ITEMS.filter(i => new Set(i.options).size !== i.options.length);
  return bad.length === 0 || 'repeated options within: ' + bad.map(i => i.id).join(', ');
});

t('OPTIONS · no option carries an agree/disagree pole', () => {
  const bad = [];
  ALL_ITEMS.forEach(i => i.options.forEach((o, n) => {
    if (/\b(strongly\s+)?(agree|disagree)\b/i.test(o)) bad.push(i.id + '[' + n + ']');
  }));
  return bad.length === 0 || 'agreement wording at: ' + bad.join(', ') +
    ' — an agree pole measures confidence, not what exists';
});

t('OPTIONS · the lowest option describes an absence, not a mild positive', () => {
  // Level 0 must be the naive/nothing-in-place state. If it reads positively the
  // whole scale is shifted and a floor score overstates the institution.
  const suspicious = ALL_ITEMS.filter(i => {
    const low = i.options[0].toLowerCase();
    const negated = /\b(no|not|nothing|nowhere|never|none|does not|do not|is not|there is no)\b/.test(low);
    const guessy = /guess|ad hoc|informal|unclear|varies|only what|case by case|their own/.test(low);
    return !negated && !guessy;
  });
  return suspicious.length === 0
    || 'lowest option may not describe an absence at: ' + suspicious.map(i => i.id).join(', ');
});

t('OPTIONS · scoring reads the option index, so a full sweep hits every level', () => {
  const seen = new Set();
  for (let v = 0; v < SCALE.filter(o => !o.dk && !o.na).length; v++) {
    setAll(() => val(v));
    scoreAll().results.forEach(r => seen.add(Math.round(r.pct)));
  }
  return seen.has(0) && seen.has(100) || 'sweep produced percentages: ' + [...seen].join(', ');
});

/* ----------------------------------------------------------- SCALE SURFACE */
/* The surfaces checklist. The predecessor SOP enumerated the dimension-count
   surface but never the SCALE surface, so a 0-based instrument 400s every
   submission against a validator written for a 1..5 one. Pin the bounds. */

t('SCALE · exactly four scored options plus DK plus N/A', () => {
  const scored = SCALE.filter(o => !o.dk && !o.na);
  if (scored.length !== 4) return 'expected 4 scored options, got ' + scored.length;
  if (SCALE.filter(o => o.dk).length !== 1) return 'expected exactly one DK option';
  if (SCALE.filter(o => o.na).length !== 1) return 'expected exactly one N/A option';
  return true;
});

t('SCALE · scored values are 0..3, contiguous, ascending', () => {
  const vs = SCALE.filter(o => !o.dk && !o.na).map(o => o.v);
  return vs.join(',') === '0,1,2,3' || 'scored values are ' + vs.join(',');
});

t('SCALE · unscored options carry a null value, never a number', () => {
  return SCALE.filter(o => o.dk || o.na).every(o => o.v === null)
    || 'an unscored option carries a numeric value — this is the v1 defect where DK scored 0';
});

t('SCALE · the percentage denominator matches the scale maximum', () => {
  setAll(() => val(3));
  const r = scoreAll().results[0];
  return r.pct === 100 || 'all-maximum answers produced ' + r.pct + '%, not 100%';
});

t('SCALE · all-minimum answers produce 0%', () => {
  setAll(() => val(0));
  return scoreAll().results[0].pct === 0 || 'all-zero answers did not produce 0%';
});

/* ------------------------------------------------------------- SIMULATION */
/* The doc requires simulating the band distribution before shipping: a
   conjunctive rule gets harder as component count rises, and an over-gated
   instrument puts every institution in the bottom band. */

t('SIMULATION · all four headline bands are reachable', () => {
  const rnd = makeRnd(4242);
  const seen = new Set();
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < 20000; i++) {
    // Each component draws its OWN quality level. Drawing one level for the
    // whole instrument makes components move together, so mixed profiles never
    // occur and the two middle bands are never sampled — which looks exactly
    // like over-gating and is not.
    const quality = {};
    COMPONENTS.forEach(c => { quality[c.id] = rnd(4); });
    setAll(c => val(Math.min(3, quality[c.id] + rnd(2))));
    const s = scoreAll();
    if (s.insufficientOverall) continue;
    seen.add(s.overall.band);
    counts[s.overall.rank]++;
  }
  if (seen.size < 4) return 'only reached: ' + [...seen].join(', ');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const bottomShare = counts[0] / total;
  if (bottomShare > 0.9) return 'over-gated — ' + Math.round(bottomShare * 100) + '% of simulated institutions land in the bottom band';
  module.exports.distribution = counts;
  return true;
});

t('SIMULATION · a perfect response set reaches the top band uncapped', () => {
  setAll(() => val(3));
  const s = scoreAll();
  if (s.firstBreak) return 'a perfect response set produced a break';
  if (s.overall.band !== 'Floor in place') return 'perfect set produced ' + s.overall.band;
  return s.capped === false || 'perfect set was flagged as capped';
});

t('SIMULATION · a worst-case response set reaches the bottom band', () => {
  setAll(() => val(0));
  const s = scoreAll();
  return s.overall.rank === 0 || 'all-zero produced ' + s.overall.band;
});

/* --------------------------------------------------------- FRACTURE COPY */
/* v1 said "Everything above rests on X" unconditionally. When the break IS the
   topmost rung, nothing is above it and the sentence pointed at an empty set. */

t('FRACTURE · a mid-ladder break says everything above rests on it', () => {
  setAll(c => val(c.id === 'c01' ? 0 : 3));
  const s = scoreAll();
  const copy = fractureCopy(s.results, s.firstBreak);
  return /^Everything above rests on/.test(copy) || 'got: ' + copy;
});

t('FRACTURE · a break on the TOP rung does not claim anything is above it', () => {
  setAll(c => val(c.id === 'c04' ? 0 : 3));   // c04 is last in build order
  const s = scoreAll();
  if (s.firstBreak.component.id !== 'c04') return 'fixture no longer breaks on the last component';
  const copy = fractureCopy(s.results, s.firstBreak);
  if (/Everything above/.test(copy)) return 'still claims something is above the top rung: ' + copy;
  return /floor stops/.test(copy) || 'unexpected copy: ' + copy;
});

t('FRACTURE · copy names the component that actually broke', () => {
  setAll(c => val(c.id === 'c05' ? 0 : 3));
  const s = scoreAll();
  return fractureCopy(s.results, s.firstBreak).includes(s.firstBreak.component.name)
    || 'fracture copy does not name the breaking component';
});

/* ------------------------------------------------------------ ACTION GRID */
/* 5 components x 4 bands. A missing cell renders an empty recommendation with
   no error: the reader gets a component named as their next move and nothing
   to do about it. */

t('ACTIONS · every component has an entry with a why and a byBand block', () => {
  const missing = COMPONENTS.filter(c => !COMPONENT_ACTIONS[c.id] || !COMPONENT_ACTIONS[c.id].byBand);
  if (missing.length) return 'no actions for: ' + missing.map(c => c.num).join(', ');
  const noWhy = COMPONENTS.filter(c => !COMPONENT_ACTIONS[c.id].why);
  return noWhy.length === 0 || 'no why for: ' + noWhy.map(c => c.num).join(', ');
});

t('ACTIONS · the grid is complete — every component x every band', () => {
  const holes = [];
  COMPONENTS.forEach(c => COMPONENT_BANDS.forEach(b => {
    const copy = COMPONENT_ACTIONS[c.id] && COMPONENT_ACTIONS[c.id].byBand[b.label];
    if (!copy || !copy.trim()) holes.push(c.num + ' / ' + b.label);
  }));
  const cells = COMPONENTS.length * COMPONENT_BANDS.length;
  if (holes.length) return holes.length + ' empty of ' + cells + ' cells: ' + holes.join(', ');
  return true;
});

t('ACTIONS · band keys match COMPONENT_BANDS exactly — no orphaned copy', () => {
  const valid = COMPONENT_BANDS.map(b => b.label).sort().join('|');
  for (const c of COMPONENTS) {
    const keys = Object.keys(COMPONENT_ACTIONS[c.id].byBand).sort().join('|');
    if (keys !== valid) return c.num + ' keys are [' + keys + '], bands are [' + valid + ']';
  }
  return true;
});

t('ACTIONS · the four actions for a component are all different', () => {
  for (const c of COMPONENTS) {
    const vals = Object.values(COMPONENT_ACTIONS[c.id].byBand);
    if (new Set(vals).size !== vals.length) return c.num + ' repeats the same action across bands';
  }
  return true;
});

t('ACTIONS · actionFor returns real copy at every reachable band', () => {
  const seen = new Set();
  [0, 1, 2, 3].forEach(v => {
    setAll(() => val(v));
    scoreAll().results.forEach(r => {
      const a = actionFor(r);
      if (!a || !a.trim()) throw new Error('empty action for ' + r.component.num + ' at ' + r.band.label);
      seen.add(r.band.label);
    });
  });
  return seen.size >= 3 || 'only reached bands: ' + [...seen].join(', ');
});

t('ACTIONS · an unassessed component gets the establish-first action, not a band action', () => {
  setAll(c => c.id === 'c01' ? DK : val(3));
  const r = scoreAll().results.find(x => x.component.id === 'c01');
  const a = actionFor(r);
  if (!/Establish what exists/i.test(a)) return 'got: ' + a;
  const banded = Object.values(COMPONENT_ACTIONS.c01.byBand);
  return !banded.includes(a) || 'returned a band action for an unassessed component';
});

t('ACTIONS · no action is left as placeholder text', () => {
  const bad = [];
  COMPONENTS.forEach(c => Object.entries(COMPONENT_ACTIONS[c.id].byBand).forEach(([b, copy]) => {
    if (/TODO|TBD|Lorem|xxx/i.test(copy) || copy.length < 40) bad.push(c.num + '/' + b);
  }));
  return bad.length === 0 || 'placeholder or too-short copy at: ' + bad.join(', ');
});

/* ----------------------------------------------------------- LAYER PATTERN */
/* Three layers, each holding or not, gives eight shapes. A missing signature
   renders an empty diagnosis; a guessed one is worse than none. */

t('PATTERN · all eight signatures are defined', () => {
  const want = ['000','001','010','011','100','101','110','111'];
  const missing = want.filter(k => !LAYER_PATTERNS[k]);
  return missing.length === 0 || 'missing signatures: ' + missing.join(', ');
});

t('PATTERN · every pattern has a name, a description and a consequence', () => {
  const bad = Object.entries(LAYER_PATTERNS).filter(([k, v]) =>
    !v.name || !v.looks || !v.next || v.looks.length < 60 || v.next.length < 60);
  return bad.length === 0 || 'incomplete pattern copy at: ' + bad.map(x => x[0]).join(', ');
});

t('PATTERN · no pattern name reuses an overall band name', () => {
  // The band and the pattern are different readings and can disagree: all five
  // components holding at 67% gives band "Partial floor" and a pattern where
  // every layer holds. While those two scales shared the phrase "Floor in
  // place" the report contradicted itself on any mid-range result, which is
  // where most institutions land. Nothing errored and no test looked.
  const bands = OVERALL_BANDS.map(b => b.band.trim().toLowerCase());
  const clash = Object.keys(LAYER_PATTERNS)
    .filter(sig => bands.indexOf(LAYER_PATTERNS[sig].name.trim().toLowerCase()) !== -1)
    .map(sig => sig + ' "' + LAYER_PATTERNS[sig].name + '"');
  return clash.length === 0 || 'pattern name reuses an overall band name: ' + clash.join(', ');
});

t('PATTERN · pattern names are distinct', () => {
  const names = Object.values(LAYER_PATTERNS).map(v => v.name);
  return new Set(names).size === names.length || 'duplicate pattern names';
});

t('PATTERN · every signature is reachable from a real response set', () => {
  // Drive each layer independently: tier 1 = c01/c02, tier 2 = c05, tier 3 = c03/c04.
  const seen = new Set();
  [0, 1].forEach(d => [0, 1].forEach(b => [0, 1].forEach(o => {
    const want = { 1: d, 2: b, 3: o };
    setAll(c => val(want[c.component ? c.component.tier : c.tier] ? 3 : 0));
    const sig = layerSignature(scoreAll().results);
    if (sig) seen.add(sig);
  })));
  return seen.size === 8 || 'only reached ' + seen.size + ' of 8: ' + [...seen].sort().join(', ');
});

t('PATTERN · the signature agrees with which layers actually hold', () => {
  const rnd = makeRnd(777);
  for (let i = 0; i < 3000; i++) {
    setAll(() => val(rnd(4)));
    const res = scoreAll().results;
    const sig = layerSignature(res);
    if (!sig) continue;
    [1, 2, 3].forEach((tier, idx) => {
      const holds = res.filter(r => r.component.tier === tier).every(r => r.holds);
      if ((sig[idx] === '1') !== holds) {
        throw new Error('iteration ' + i + ': signature ' + sig + ' disagrees with tier ' + tier);
      }
    });
  }
  return true;
});

t('PATTERN · withheld, not guessed, when a layer contains an unassessed component', () => {
  setAll(c => c.id === 'c05' ? DK : val(3));
  const res = scoreAll().results;
  if (layerSignature(res) !== null) return 'named a pattern despite an unassessed layer';
  return patternFor(res) === null || 'patternFor returned a pattern for an indeterminate ladder';
});

t('PATTERN · a fully-holding instrument reports the top pattern', () => {
  setAll(() => val(3));
  const pat = patternFor(scoreAll().results);
  return (pat && pat.signature === '111') || 'got ' + (pat && pat.signature);
});

t('PATTERN · procurement-led is reachable and named', () => {
  setAll(c => val(c.tier === 3 ? 3 : 0));
  const pat = patternFor(scoreAll().results);
  if (!pat || pat.signature !== '001') return 'got signature ' + (pat && pat.signature);
  return pat.name === 'Procurement-led' || 'named ' + pat.name;
});

t('PATTERN · no shipped pattern copy asserts a frequency', () => {
  // Frequencies were inferred, not observed. Stating them confidently is the
  // failure this instrument exists to catch, so they stay out of the product.
  const bad = Object.entries(LAYER_PATTERNS).filter(([k, v]) =>
    /\b(most common|very common|commonly|rare|rarely|frequen|typical(ly)? seen|usually found)\b/i.test(v.looks + ' ' + v.next));
  return bad.length === 0 || 'frequency claim in: ' + bad.map(x => x[0]).join(', ');
});

/* ------------------------------------------------------ VERSION & SCREENS */

t('VERSION · INSTRUMENT_VERSION is a positive integer', () => {
  return (Number.isInteger(INSTRUMENT_VERSION) && INSTRUMENT_VERSION >= 1)
    || 'got ' + INSTRUMENT_VERSION;
});

t('VERSION · the storage key is namespaced by instrument version', () => {
  // Restoring answers written against different item wording would silently
  // score a respondent on questions they never saw.
  return STORAGE_KEY.indexOf(String(INSTRUMENT_VERSION)) !== -1
    || 'storage key "' + STORAGE_KEY + '" does not carry the version';
});

t('SCREENS · intro + every component + review + results, in order', () => {
  const want = ['screen-intro'].concat(COMPONENTS.map(c => 'screen-' + c.id))
    .concat(['screen-review', 'screen-results']);
  return SCREENS.join('|') === want.join('|') || 'got ' + SCREENS.join('|');
});

t('SCREENS · review sits immediately before results', () => {
  if (REVIEW_STEP !== COMPONENTS.length) return 'REVIEW_STEP is ' + REVIEW_STEP;
  return RESULTS_STEP === REVIEW_STEP + 1 || 'RESULTS_STEP is ' + RESULTS_STEP;
});

/* ------------------------------------------------------------ COPY LIMITS */
/* Two stems previously ran to 19 words and one option to 18. Long stems get
   skimmed and long options get compared badly against short ones. */

t('COPY · no stem exceeds 18 words', () => {
  const long = ALL_ITEMS.map(i => ({ id: i.id, w: i.stem.split(/\s+/).length }))
    .filter(x => x.w > 18);
  return long.length === 0 || 'over-long stems: ' + long.map(x => x.id + ' (' + x.w + ')').join(', ');
});

t('COPY · no option exceeds 17 words', () => {
  const long = [];
  ALL_ITEMS.forEach(i => i.options.forEach((o, n) => {
    const w = o.split(/\s+/).length;
    if (w > 17) long.push(i.id + '[' + n + '] (' + w + ')');
  }));
  return long.length === 0 || 'over-long options: ' + long.join(', ');
});

t('COPY · no item names specific job titles that may not exist', () => {
  // "an executive, a dean, an adjunct and an IT lead" assumed an org chart a
  // single-campus technical college does not have.
  const bad = ALL_ITEMS.filter(i => /\b(adjunct|provost|dean)\b/i.test(i.stem));
  return bad.length === 0
    || 'stems assume specific titles: ' + bad.map(i => i.id).join(', ');
});

/* -------------------------------------------------- DK CANNOT BUY A RATING */
/* Not scoring "Don't know" is not enough on its own. Until the band was gated
   on coverage, 3x Operating + 2x DK returned 100% and held, while an honest
   5x Not-in-place returned 0% and failed - so silence outscored candour. */

t('DK ECONOMY · a DK-heavy component cannot outrank an honestly weak one', () => {
  setAll((c, item, ci, ii) => ci === 0 ? (ii < 3 ? val(3) : DK) : val(3));
  const dkHeavy = scoreAll().results[0];
  setAll((c, item, ci) => ci === 0 ? val(0) : val(3));
  const honest = scoreAll().results[0];
  if (dkHeavy.holds) return 'a component with 2 of 5 unknown still holds';
  if (dkHeavy.pct !== null) return 'an unrateable component still reports ' + dkHeavy.pct + '%';
  return honest.holds === false || 'fixture no longer contrasts the two';
});

t('DK ECONOMY · answering Don\'t know never beats answering the lowest option', () => {
  // Sweep every count of DK against the same count of honest zeros.
  for (let n = 1; n <= 5; n++) {
    setAll((c, item, ci, ii) => ci === 0 ? (ii < 5 - n ? val(3) : DK) : val(3));
    const withDk = scoreAll().results[0];
    setAll((c, item, ci, ii) => ci === 0 ? (ii < 5 - n ? val(3) : val(0)) : val(3));
    const withZero = scoreAll().results[0];
    if (withDk.holds && !withZero.holds && withDk.scored < withZero.scored) {
      // holding on strictly less evidence than the honest answer is the bug
      if (withDk.coverage < COVERAGE_FLOOR) return n + ' DK answers held below the coverage floor';
    }
  }
  return true;
});

t('COVERAGE · a component below the two-thirds floor is unrateable', () => {
  setAll((c, item, ci, ii) => ci === 0 ? (ii < 3 ? val(3) : DK) : val(3));
  const r = scoreAll().results[0];
  if (r.coverage >= COVERAGE_FLOOR) return 'fixture coverage is ' + r.coverage;
  return r.insufficient === true || 'rated a component at ' + Math.round(r.coverage * 100) + '% coverage';
});

t('COVERAGE · one Don\'t know in five is still rateable', () => {
  setAll((c, item, ci, ii) => ci === 0 ? (ii < 4 ? val(3) : DK) : val(3));
  const r = scoreAll().results[0];
  return (!r.insufficient && r.holds) || 'a single DK made the component unrateable';
});

t('COVERAGE · Not applicable does not push a component below the floor', () => {
  setAll((c, item, ci, ii) => ci === 0 ? (ii < 4 ? val(3) : NA) : val(3));
  const r = scoreAll().results[0];
  if (r.applicable !== 4) return 'expected 4 applicable, got ' + r.applicable;
  return (!r.insufficient && r.coverage === 1) || 'N/A reduced coverage to ' + r.coverage;
});

t('COVERAGE · an unrateable component reports no percentage and no band', () => {
  setAll(c => c.id === 'c01' ? DK : val(3));
  const r = scoreAll().results.find(x => x.component.id === 'c01');
  if (r.pct !== null) return 'reported ' + r.pct + '% while unrateable';
  return r.band.label === 'Insufficient evidence' || 'band reads ' + r.band.label;
});

t('COVERAGE · an unrateable component never feeds the compensatory mean', () => {
  setAll((c, item, ci, ii) => ci === 0 ? (ii < 3 ? val(0) : DK) : val(3));
  const s = scoreAll();
  const rated = s.results.filter(r => r.pct !== null);
  if (rated.some(r => r.component.id === 'c01')) return 'the unrateable component was included';
  const mean = rated.reduce((a, r) => a + r.pct, 0) / rated.length;
  return Math.abs(mean - s.compensatory) < 0.001
    || 'compensatory ' + s.compensatory + ' does not match the mean of rated components ' + mean;
});

/* ------------------------------------------------------------ COPY BUDGET */
/* Report copy grew back three times in one session, always the same way: a
   sentence narrating what the software did, a sentence justifying the ask, or
   a restatement of the sentence above it. Budgets are set just above the
   current copy, so any block that grows has to be a deliberate decision rather
   than a drift. Raising a number here is fine; doing it without reading the
   block out loud is not. */

const BUDGET = {
  'OVERALL_BANDS.text':      40,
  'LAYER_PATTERNS.looks':    45,
  'LAYER_PATTERNS.next':     60,
  'COMPONENT_ACTIONS.why':   30,
  'COMPONENT_ACTIONS cell':  48,
  'component blurb':         30,
  'bandtext':                40,
  'capnote':                 45,
  'rlead':                   40,
  'disclose':                80,
  'nextstep':                90,
  'dk flag':                 35,
  'whole report':          1600
};

function overBudget(label, items) {
  const cap = BUDGET[label];
  return items.map((t, i) => ({ i, w: words(t) })).filter(x => x.w > cap)
    .map(x => label + '[' + x.i + '] ' + x.w + 'w > ' + cap);
}

t('COPY BUDGET · scored data copy stays within budget', () => {
  const over = []
    .concat(overBudget('OVERALL_BANDS.text', OVERALL_BANDS.map(b => b.text)))
    .concat(overBudget('LAYER_PATTERNS.looks', Object.values(LAYER_PATTERNS).map(p => p.looks)))
    .concat(overBudget('LAYER_PATTERNS.next', Object.values(LAYER_PATTERNS).map(p => p.next)))
    .concat(overBudget('COMPONENT_ACTIONS.why', Object.values(COMPONENT_ACTIONS).map(a => a.why)))
    .concat(overBudget('COMPONENT_ACTIONS cell', Object.values(COMPONENT_ACTIONS).flatMap(a => Object.values(a.byBand))))
    .concat(overBudget('component blurb', COMPONENTS.map(c => c.blurb)));
  return over.length === 0 || over.join('; ');
});

// Render a report that exercises every block: a ladder break so the cap note
// and focus box appear, and three DK so the flag fires.
function renderedReport() {
  setAll((c, item, ci, ii) => (ci === 1 && ii >= 2) ? DK : val(ci > 2 ? 3 : 1));
  app.render();
  return DOM['rbody'].innerHTML;
}

t('COPY BUDGET · the harness can actually read the rendered report', () => {
  // Guards the guard: a broken extractor would make every budget below pass
  // by finding nothing to measure.
  const html = renderedReport();
  if (words(html) < 200) return 'render produced only ' + words(html) + ' words';
  const found = blocks(html, 'bandtext');
  return found.length === 1 || 'expected exactly one bandtext block, found ' + found.length;
});

t('COPY BUDGET · rendered report blocks stay within budget', () => {
  const html = renderedReport();
  const over = []
    .concat(overBudget('bandtext', blocks(html, 'bandtext')))
    .concat(overBudget('capnote', blocks(html, 'capnote')))
    .concat(overBudget('rlead', blocks(html, 'rlead')))
    .concat(overBudget('disclose', blocks(html, 'disclose')))
    .concat(overBudget('nextstep', blocks(html, 'nextstep')))
    .concat(overBudget('dk flag', blocks(html, 'flag')));
  return over.length === 0 || over.join('; ');
});

t('COPY BUDGET · the whole report stays within budget', () => {
  const n = words(renderedReport());
  return n <= BUDGET['whole report'] || 'report is ' + n + 'w, budget ' + BUDGET['whole report'];
});

t('COPY BUDGET · no report block narrates the mechanism', () => {
  // The specific phrasing that kept coming back. Not exhaustive, but these are
  // the exact constructions that were cut, and they should not return.
  const html = renderedReport();
  const banned = [
    'removed from the calculation',
    'removed from their component',
    'scored against you',
    'is not scored until',
    'nothing is scored',
    'so it changes as you re-assess'
  ];
  const text = html.replace(/<[^>]*>/g, ' ').toLowerCase();
  const hits = banned.filter(b => text.indexOf(b) !== -1);
  return hits.length === 0 || 'mechanism narration returned: "' + hits.join('", "') + '"';
});

t('COPY · the rendered report carries no unfilled placeholder', () => {
  // The contact line shipped as "[SBD: contact line, booking link or email goes
  // here]" and sat on every result produced. Nothing errored, nothing rendered
  // wrong, and no test looked. A bracketed placeholder is the one kind of copy
  // defect that is trivial to detect and embarrassing to ship.
  const text = renderedReport().replace(/<[^>]*>/g, ' ');
  const bracketed = text.match(/\[[^\]]{4,}\]/g) || [];
  const marked = /\bTODO\b|\bTBD\b|Lorem ipsum|goes here/i.test(text) ? ['TODO/TBD/goes here'] : [];
  const hits = bracketed.concat(marked);
  return hits.length === 0 || 'placeholder still in the report: ' + hits.join(', ');
});

t('COPY BUDGET · the Don\'t know flag only appears when the count is a finding', () => {
  setAll((c, item, ci, ii) => (ci === 0 && ii === 0) ? DK : val(2));
  app.render();
  if (blocks(DOM['rbody'].innerHTML, 'flag').length) return 'flag rendered for a single Don\'t know';
  setAll((c, item, ci, ii) => (ci === 0 && ii < 3) ? DK : val(2));
  app.render();
  return blocks(DOM['rbody'].innerHTML, 'flag').length === 1 || 'flag missing at three Don\'t know';
});

/* ----------------------------------------------------------------- report */

console.log('');
console.log('  MVG Readiness Assessment — instrument battery');
console.log('  ' + '-'.repeat(52));
if (failures.length) {
  failures.forEach(f => console.log('  FAIL  ' + f));
  console.log('');
}
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
process.exit(fail ? 1 : 0);
