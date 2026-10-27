# UI redesign log

Goal: a calm, professional desktop app in the class of the Claude and Codex
apps. Quiet surfaces, one typeface family, small consistent icons, plain
names, and every task reachable in one or two clicks. UI only; the engine
and its rules stay as they are.

## What is wrong today

### Name and words
- "QA Arena", "Arena", "DNA", "Thinker", "Improver", "Debate round",
  "Host-confirmed" are metaphors a new user has to decode.
- Marketing copy inside the product: "Your next audit starts here.",
  "From a question to evidence.", "Evidence decides.", "The arena is ready."
- The same thing has several names: claim, finding, defect; challenge,
  review, debate.
- Status words are internal: "candidate", "needs_review", "inconclusive",
  "rejected" shown raw.

### Layout and hierarchy
- Poster-sized headlines (60 px+) on every screen, so nothing else stands out.
- Big-number tiles and black promo cards repeated on every page.
- An all-caps "QA ARENA / LOCAL WORKSPACE" bar that adds nothing.
- "Audit setup" is a nav item, though it is a step that needs a project.
- The setup form is one long page with a dark sales panel beside it.
- Finding details open in a modal that hides the list you were working through.
- Settings, accounts, and agent choices are spread over several screens.

### Visual details
- Hand-drawn icons of uneven weight and size.
- Yellow fills used for selection, status, buttons, and decoration at once.
- Heavy black blocks next to hairlines next to dashed borders.
- Several type styles (wide display, condensed numerals, mono labels).
- No dark mode.

## What replaces it

### Name
**Baton**: the conductor's baton, the thing that orchestrates. Subtitle where
needed: "QA agent orchestration".

### Words (one name per idea)
| Today | New |
|---|---|
| Arena, run | Audit |
| Claim, defect | Finding |
| Challenge, debate | Review |
| Debate round | Review round |
| DNA, genes, rules | Playbook, guidelines |
| Rule change | Suggestion |
| Builder / Researcher / Thinker / Reporter / Improver | Build / Test / Review / Report / Learn agents |
| White box / Black box / Both | Code review / Live app / Code and live app |
| Offline runtime | Built-in (no AI model) |
| confirmed / rejected / inconclusive / needs_review / candidate | Confirmed / False positive / Unverified / Needs review / Pending |
| Host verified, replay | Verified by replay; Code reference verified |

### Visual system
- Typeface: Geist for the interface, Geist Mono for code. 14 px body,
  13 px secondary, 12 px captions, 20 px page titles. No display type.
- Color: neutral greys with one accent (indigo) for focus, links, and the
  active item. Status colors only where they carry meaning: red confirmed
  finding, amber needs review, green verified or connected, grey dismissed.
- Light and dark themes from the same tokens, following the system setting.
- Icons: one library (Phosphor, regular weight) at 16 px in controls and
  20 px in empty states. No sparkles, robots, or wands.
- Radius 6 px on controls, 10 px on panels, 12 px on dialogs. 1 px borders.
  Shadows only on floating layers.

### Layout
- Left sidebar: Baton mark, "New audit" button, Audits, Projects, Findings,
  Playbook, then recent audits; Settings and provider status at the bottom.
- Each page: compact header (title, short subtitle, actions on the right)
  and content in a single column or a table.
- New audit: one form with sections (Project, Scope, How to test, Agents)
  and an "Advanced" fold for depth, exclusions, library, and instructions.
  A footer bar summarizes the choice and holds "Start audit".
- Audit page: header with status and controls, a five-step progress strip
  (Build, Test, Review, Report, Learn), then tabs: Overview, Findings,
  Activity, Report, Details.
- Findings open in a side panel, so the list stays visible. Needs-review
  findings get "Confirm" and "Mark false positive" right in the panel.
- Settings: Accounts (connect Claude and Codex), Default agents, Knowledge
  library, Advanced paths.

### Checks before calling it done
- Every screen at 1280x800 and 1680x1050, light and dark.
- Keyboard: visible focus, Escape closes panels and dialogs.
- Empty, loading, and error states on every list.
- The desktop smoke check runs a full audit through the new screens.
