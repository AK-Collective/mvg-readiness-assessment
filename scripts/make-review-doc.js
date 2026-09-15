// Builds the client review document: every question, option, recommended action
// and institution pattern, pulled straight out of index.html so the copy the
// client marks up is always exactly the copy that ships.
//
//   node scripts/make-review-doc.js . review.html
//
// Then upload review.html to Drive as a native Google Doc (commentable, which
// is the point of a review). Do NOT hand-patch the document afterwards: apply
// the client's edits to index.html and regenerate.
//
// Phase I of instrument-design-SOP.md gates when to run this - only after the
// internal copy passes are finished, or the client marks up wording that was
// about to change anyway.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.argv[2];
const OUT = process.argv[3];

const html0 = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const m = html0.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
const node = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [],
  textContent: '', innerHTML: '', value: '', hidden: false,
  appendChild() {}, addEventListener() {}, removeAttribute() {}, setAttribute() {},
  querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {}, closest: () => null
});
const sb = {
  document: { getElementById: node, createElement: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
  window: { addEventListener() {}, print() {}, scrollTo() {} },
  history: { pushState() {}, length: 1 }, CSS: { escape: x => x },
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  setTimeout() {}, console, module: { exports: {} }
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(m[1], sb);
const A = sb.module.exports;

const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const L = [];
const push = (...x) => L.push(...x);

push('<html><head><meta charset="utf-8"><title>MVG Readiness Assessment — Content for review</title></head><body>');

// cover
push('<p><span style="color:#7A5B12;font-weight:bold;letter-spacing:2px;font-size:10pt">MINIMUM VIABLE GOVERNANCE FOR AI</span></p>');
push('<h1 style="color:#0A1830">Readiness Assessment</h1>');
push('<p><i style="color:#5D6B80;font-size:14pt">Content for review</i></p>');
push('<p style="color:#5D6B80;font-size:10pt">For Judith and the team at Strategies by Design Group &nbsp;·&nbsp; <b>The AK Collective</b></p>');
push('<hr>');

push('<p>Everything the assessment says is in this document. It is all drafted, so this is reading and marking what is wrong rather than writing anything.</p>');
push('<p style="background-color:#F7F3EA"><b>Mark it up however suits you.</b> Comments, suggestions, or a list of notes all work. If a whole section is fine, saying so is a useful answer.</p>');

push('<h2>What is in here</h2><ul>');
push('<li><b>Part 1.</b> The 25 questions and the four answers each one offers.</li>');
push('<li><b>Part 2.</b> The recommended actions. Each component has four, one for each level it can land on.</li>');
push('<li><b>Part 3.</b> The eight institution patterns the report can name.</li>');
push('<li><b>Part 4.</b> Two decisions we need from you, and your contact line.</li>');
push('</ul>');

push('<h2>To see it working</h2>');
push('<p><a href="https://ak-collective.github.io/mvg-readiness-assessment/">https://ak-collective.github.io/mvg-readiness-assessment/</a></p>');
push('<p>Takes about 15 to 20 minutes and saves as you go. Nothing is stored anywhere and the result prints to PDF.</p>');
push('<p><i style="color:#5D6B80">One run through shows you one result out of many, which is why the full content is written out below.</i></p>');

// ---------------------------------------------------------------- Part 1
push('<hr style="page-break-before:always">');
push('<h1>Part 1. The questions</h1>');
push('<p>Twenty-five questions across the five components. The respondent picks the description that matches their institution, so they never rate themselves and never see a scale. The answers run from least in place (A) to fully operating (D).</p>');
push('<p>Mark anything where the question does not ask what you meant, two answers could describe the same institution, a real institution would sit in a gap between two of them, or the wording would put a provost on the defensive.</p>');

A.COMPONENTS.forEach((c, ci) => {
  push('<h2>Section ' + (ci + 1) + ' of 5 &nbsp;·&nbsp; ' + e(c.name) + '</h2>');
  push('<p><i style="color:#5D6B80">' + e(c.blurb) + '</i></p>');
  c.items.forEach((item, ii) => {
    push('<p><b>' + (ii + 1) + '. ' + e(item.stem) + '</b></p>');
    push('<ul>');
    ['A', 'B', 'C', 'D'].forEach((ltr, k) =>
      push('<li><span style="color:#5D6B80"><b>' + ltr + '</b></span> &nbsp; ' + e(item.options[k]) + '</li>'));
    push('</ul>');
  });
});

// ---------------------------------------------------------------- Part 2
push('<hr style="page-break-before:always">');
push('<h1>Part 2. The recommended actions</h1>');
push('<p>Every component has four recommendations, one for each level it can land on. An institution at the bottom and one in the middle get different advice, which is what stops the report reading as a scorecard.</p>');
push('<p style="background-color:#F7F3EA"><b>Flag anything that is wrong, too generic, or not how you would put it.</b> Rewriting is not the expectation.</p>');

A.COMPONENTS.forEach(c => {
  const a = A.COMPONENT_ACTIONS[c.id];
  push('<h2>' + e(c.name) + '</h2>');
  push('<p><i style="color:#5D6B80">' + e(a.why) + '</i></p>');
  ['Absent', 'Emerging', 'Established', 'Operating'].forEach(b => {
    push('<h3 style="color:#7A5B12">' + b + '</h3>');
    push('<p>' + e(a.byBand[b]) + '</p>');
  });
});

// ---------------------------------------------------------------- Part 3
push('<hr style="page-break-before:always">');
push('<h1>Part 3. The institution patterns</h1>');
push('<p>The three layers each either hold or they do not, which gives eight shapes. The score says how far along an institution is. The pattern says what kind of incomplete it is, and it is the part of the report that will sell the work.</p>');
push('<p>Tell us whether the names describe something you recognise, and whether the "what tends to happen next" line is true and pitched right. It is currently direct about consequence without being a scare tactic. Where that line sits is your call.</p>');

const LAYERS = ['Define', 'Bound', 'Operate'];
Object.keys(A.LAYER_PATTERNS).sort().reverse().forEach(sig => {
  const p = A.LAYER_PATTERNS[sig];
  push('<h2>' + e(p.name) + '</h2>');
  push('<p style="color:#5D6B80;font-size:10pt"><b>' +
    LAYERS.map((l, i) => l + (sig[i] === '1' ? ' holds' : ' does not')).join(' &nbsp;·&nbsp; ') + '</b></p>');
  push('<p>' + e(p.looks) + '</p>');
  push('<p><b>What tends to happen next.</b> ' + e(p.next) + '</p>');
});

// ---------------------------------------------------------------- Part 4
push('<hr style="page-break-before:always">');
push('<h1>Part 4. What we need back</h1>');
push('<h2>Your contact line</h2>');
push('<p>The report ends by pointing the reader to you, and currently shows a placeholder. Send us the line, a booking link, or an email address.</p>');
push('<h2>How common is each pattern?</h2>');
push('<p>Our draft noted things like "very common in multi-campus systems". Those are our guess rather than something we have observed, so we left them out. If they match what you have seen across clients we will put them back. If not, they stay out.</p>');
push('<h2>Will this ever be sold into an accreditation, funding or contract context?</h2>');
push('<p>Right now it assumes the respondent has no reason to overstate. If a result ever affects money or status for the institution being assessed, that assumption breaks and the instrument needs an evidence requirement, where the top answer means you can point to the document. Better to know early than to retrofit it.</p>');
push('<h2>Do you want several people at one institution compared?</h2>');
push('<p>Disagreement between informed colleagues about whether something exists is one of the most useful findings available. Comparing them automatically needs somewhere to store results, which is a larger build. Say the word and we will scope it.</p>');

push('</body></html>');

const out = L.join('\n');
fs.writeFileSync(OUT, out, 'utf8');
const q = A.COMPONENTS.reduce((n, c) => n + c.items.length, 0);
console.log('wrote ' + OUT);
console.log('  bytes: ' + Buffer.byteLength(out) + '   questions: ' + q +
  '   actions: ' + Object.values(A.COMPONENT_ACTIONS).reduce((n, x) => n + 4, 0) +
  '   patterns: ' + Object.keys(A.LAYER_PATTERNS).length);
