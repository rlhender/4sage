# Framework Decisions Log

Full reasoning for decisions about the 4SAGE Framework itself — its name,
structure, methodology, and tooling.

---

### D-001: Name "4SAGE" for the project

**Date:** 2026-03-04
**Context:** Needed a name for the AI-guided game design methodology framework.
**Decided:** 4SAGE — "Structured AI-Guided Experience Design"
**Alternatives considered:**
- SAGE (plain) — rejected because: EA's SAGE (Strategy Action Game Engine) would cause search confusion, and the word is too generic for a unique project identity.
- SageForge — rejected because: the best domain TLDs (.com, .io, .ai) were already taken by other parties.
- Arcwright — rejected because: less immediately meaningful; requires explanation.
- Codex — rejected because: too generic; commonly used across many projects.
- Crucible — rejected because: common word, harder to claim as a unique identity.
- GameSage — rejected because: less distinctive than 4SAGE; no parallel to existing 4GRP project.
**Rationale:** "4SAGE" parallels the companion project 4GRP (4th Generation Resource Planning), suggesting a family of AI-guided design frameworks. "SAGE" means wise counselor, which describes the AI's role perfectly. The "4" prefix provides uniqueness and a generational narrative. Domain availability is excellent (4sage.dev registered, 4sage.ai/io/org all available).
**References:** Project-wide naming, `README.md`

---

### D-002: Seven-level design cascade (L0–L6)

**Date:** 2026-03-04
**Context:** Needed to determine the right number of levels and their ordering for a game design decision cascade.
**Decided:** Seven levels: L0 Vision & Constraints → L1 Player Experience → L2 Core Design → L3 Systems & Content Design → L4 Presentation → L5 Architecture & Technology → L6 Implementation
**Alternatives considered:**
- Six levels (matching 4GRP's L0–L5) — rejected because: game design has a distinct "Presentation" layer (art, audio, UI) that has no clear analog in ERP. Combining it with another level would obscure important decisions.
- Eight+ levels (separating narrative, level design, etc.) — rejected because: additional levels should earn their place. Narrative and level design are content that flows through mechanical systems and naturally belongs in L3.
- Fewer levels (3-4, matching MDA's Mechanics/Dynamics/Aesthetics) — rejected because: too coarse. MDA doesn't cover vision, constraints, technology, or implementation. A practical framework needs finer granularity.
**Rationale:** Each level genuinely constrains the next: vision constrains experience goals, experience constrains mechanics, mechanics constrain systems/content, content constrains presentation, presentation constrains technology, technology constrains implementation. The ordering was validated by asking "can you answer this level without the level above?" — the answer is no for each pair.
**References:** `FRAMEWORK.md` → The Design Cascade, `kdd/README.md`

---

### D-003: Mechanics before narrative in the cascade

**Date:** 2026-03-04
**Context:** Needed to determine whether narrative/world design should come before or after core mechanics in the level ordering.
**Decided:** Core mechanics (L2) before narrative (L3). Narrative is part of Systems & Content Design.
**Alternatives considered:**
- Narrative before mechanics — rejected because: even in heavily narrative games (Disco Elysium, visual novels), the mechanical framework ("dialogue-driven RPG with skill checks," "branching visual novel") must be established before narrative can be designed. The narrative delivery mechanism is a mechanical decision.
- Narrative as its own level — rejected because: many games have no narrative at all (Tetris, chess, most puzzle games). A dedicated level would be empty for a large class of games. As part of L3, it's addressed when applicable and skipped when not.
**Rationale:** The core game loop determines how narrative is delivered, paced, and experienced. A turn-based RPG delivers story completely differently than an action game. Mechanics are the container; narrative is content that fills the container.
**References:** `FRAMEWORK.md`, `kdd/README.md`

---

### D-004: Adapt 4GRP methodology for game design

**Date:** 2026-03-04
**Context:** Needed a methodology foundation for the game design framework. Evaluated existing game design frameworks and methodologies.
**Decided:** Adapt the 4GRP (4th Generation Resource Planning) framework methodology, supplemented by MDA Framework vocabulary and traditional GDD topic coverage.
**Alternatives considered:**
- MDA Framework alone — rejected because: only three layers (Mechanics/Dynamics/Aesthetics) with no structured dialogue process, no decision logging, no priority system, no technology/implementation guidance. An analytical lens, not a design methodology.
- Traditional GDD templates — rejected because: provide topic checklists but no decision hierarchy, no dependency tracking, no structured dialogue. Fill-in-the-blank, not guided conversation.
- Build from scratch — rejected because: 4GRP already solved the hard problems of cascading decisions, priority classification, decision logging, LLM dialogue patterns, and structured markdown. No reason to reinvent.
**Rationale:** 4GRP provides the methodology skeleton (cascade, priorities, decision log, structured blocks, LLM dialogue). MDA provides conceptual vocabulary for the game-specific middle layers. Traditional GDD practice ensures complete topic coverage. The combination is stronger than any individual source.
**References:** `FRAMEWORK.md` → Intellectual Foundations, `README.md`

---

### D-005: Domain registration at 4sage.dev

**Date:** 2026-03-04
**Context:** Needed a web domain for the project.
**Decided:** Register `4sage.dev` as the primary domain.
**Alternatives considered:**
- 4sage.ai — available, strong AI signal, but more expensive (~$20-80/year vs ~$10-15/year for .dev).
- 4sage.io — available, popular for tech projects, but .io TLD has ongoing controversy about its future governance.
- 4sage.com — taken (parked since 2015 on NameBright), would require premium purchase.
- sage4.dev / sage4.ai — available, but "4SAGE" reads better as a name (parallels 4GRP) than "SAGE4."
**Rationale:** .dev is controlled by Google Registry, is well-regarded in the developer/tech community, enforces HTTPS by default (security benefit), and is affordable. Combined with the 4sage prefix, it's clean and memorable.
**References:** Project-wide
