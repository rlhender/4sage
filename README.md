# 4SAGE — Structured AI-Guided Experience Design

> **"Ask the Right Questions, In the Right Order."**
>
> 4SAGE is a game design methodology that uses AI-guided dialogue to walk
> anyone — from first-time designers to experienced studios — through the
> complete process of designing a game. Instead of staring at a blank Game
> Design Document template, you have a structured conversation where each
> decision naturally constrains and informs the next.

## The 4SAGE Philosophy

### 1. Decisions Cascade Downward
Every game design decision exists at a level. Your vision constrains your
experience goals. Your experience goals constrain your mechanics. Your
mechanics constrain your technology. This is not arbitrary structure — it
reflects how game design actually works. You cannot choose an engine before
you know what the game needs to do.

### 2. The AI Is Your Consultant and Scribe
The AI conducts the dialogue, presents best practices, challenges weak
reasoning, and suggests alternatives you haven't considered. But every
decision is made by the human designer. The AI's role is to ensure
thoroughness — to ask the questions that a team of experienced game designers
would ask — not to make choices for you.

When the AI disagrees with a choice, it says so directly, explains why, and
records the decision with its rationale anyway. Honest feedback, not yes-men.

### 3. Best Practice First, Then Diverge
At every level, the framework presents the established industry convention as
the default. The dialogue then asks: does this fit your game? Where it does,
adopt it. Where it doesn't, document the divergence and the justification.
Innovation is encouraged — but informed innovation, not accidental novelty.

### 4. Decisions Over Code
Code is replaceable; design rationale is the asset. By capturing every
decision in structured markdown — what was chosen, what was rejected, and
why — your game's design intelligence survives technology shifts, team
changes, and pivots. The "how" (code) is regenerable; the "why" (your
decisions) is permanent.

### 5. Nothing Is Forgotten
The framework records not just what you chose, but what you chose *not* to
do and why. This prevents revisiting settled decisions, documents scope
boundaries, and gives future team members full context on every design choice.

### 6. Anyone Can Design a Game
You don't need to know Unity, Unreal, or C++. You describe what you want the
player to experience. The AI translates that into structured design decisions.
The framework guides you from "I have an idea for a game" to a complete,
documented, implementable game design.

## The Design Cascade

| Level | Name | What's Decided Here |
|-------|------|-------------------|
| L0 | Vision & Constraints | Game concept, genre, platforms, audience, team, budget — the immovable facts |
| L1 | Player Experience | Emotional goals, session structure, social model, difficulty, replayability |
| L2 | Core Design | Game loop, primary mechanics, progression, win/loss conditions |
| L3 | Systems & Content Design | Detailed systems, balance, AI, narrative, level design, content scope |
| L4 | Presentation | Art direction, audio, UI/UX, game feel, accessibility |
| L5 | Architecture & Technology | Engine, networking, data, tools, performance targets |
| L6 | Implementation | Code patterns, TDD, CI/CD, deployment, live ops |

Each level constrains the next. Feedback flows upward when lower-level
discoveries force reconsideration of higher-level choices.

## Quick Orientation

| Path | What's Here |
|------|-------------|
| `FRAMEWORK.md` | Full framework definition — start here to understand the methodology |
| `kdd/` | Key Design Decisions — one file per level (L0 through L6) |
| `architecture/` | Cross-cutting technical decisions (engines, patterns, tools) |
| `decisions/` | Decision log — alternatives considered and rejection reasons |
| `common/` | Shared design elements used across multiple systems |
| `knowledge-base/` | Game design reference material, genre conventions, platform constraints |
| `references/` | Research from existing games, engines, and methodologies |
| `games/` | Playable games built in this repository — currently `hexmarch/`, a simultaneous-turn conquest game with a headless engine that AI players can drive |

## Intellectual Foundations

The 4SAGE Framework synthesizes ideas from:
- **MDA Framework** (Hunicke, LeBlanc, Zubek) — Mechanics, Dynamics, Aesthetics vocabulary for reasoning about player experience
- **Traditional GDD practice** — decades of game design document conventions for topic coverage
- **Lafley & Martin** (Strategy Choice Cascade) — cascading choices where each level constrains the next
- **Zachman Framework** — What/How/Where/Who/When/Why at every level
- **MoSCoW** (DSDM) — priority classification, adapted as MH/SH/NH/WH
- **V-Model** (Systems Engineering) — each design level has a corresponding validation
- **Original contribution** — LLM-guided dialogue for systematic game design decision capture

## Multi-LLM Project

This project is designed to be worked on by any LLM assistant (Claude, Gemini,
GPT, or any other). All knowledge is in the git-tracked files. Read `README.md`
and `CONTRIBUTING.md` for full context.
