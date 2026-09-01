# MVG AI Governance Readiness Assessment

Phase 1 readiness assessment for **Minimum Viable Governance for AI**, a framework by [Strategies by Design Group](https://strategiesbydesigngroup.com).

Twenty-five questions across five components. The result is sequenced in the order the framework depends on, so it names where to start rather than what scored lowest.

> **Preview build.** Item wording, recommended actions and thresholds are drafts pending subject-matter review. The page carries `noindex` until sign-off.

## Running it

It is one self-contained HTML file. There is no build step, no database, no server and no accounts. Open `index.html` in a browser, or serve the folder:

```bash
node scripts/dev-server.js 4321
```

Answers live in the respondent's own browser via `localStorage` and never leave their machine. The result prints to PDF, including a record of every answer given.

## Tests

```bash
node scripts/test-instrument.js
```

The harness lifts the real `index.html`, runs the shipped scoring code in a `vm` with a stubbed DOM, and asserts against it. There is no second copy of the scoring logic, so the tests cannot pass while the product drifts away from them.

Coverage includes band algebra, headline/component consistency under fuzzing, the "Don't know" and "Not applicable" rules, item and option structure, the layer-pattern diagnosis, and word budgets on every block of report copy.

## How scoring works

Each component scores as a percentage of its answered, applicable questions. A component **holds** at 60%.

The headline is the lower of two numbers: the mean across components, and a cap set by the first component that fails in **build order**. Both derive from the same component objects, so the headline can never claim more than the dependency ladder supports.

`Not applicable` leaves a component's denominator entirely. `Don't know` also leaves the denominator, so it never raises or lowers a score, but it counts against coverage. A component below two-thirds coverage is reported as unrateable rather than rated, and below two-thirds overall no headline band is issued at all.

## Layout

| Path | |
| --- | --- |
| `index.html` | The assessment. Everything. |
| `scripts/test-instrument.js` | Test battery |
| `scripts/dev-server.js` | Local static preview |

Built against `instrument-design-SOP.md` (archetype A4, single-entity gated readiness).
