# 4sage.dev Website Plan

## Design Principles

1. **Single page** — no framework, no JavaScript required, fast to load.
   One HTML file + one CSS file.
2. **Human-first, LLM-readable** — clean semantic HTML that reads well
   in a browser AND when fetched as text by an LLM.
3. **Three audiences, one page** — casual visitors, LLMs bootstrapping
   a session, and developers wanting the repo.
4. **Mobile-friendly** — responsive, readable on phones and tablets.

## Page Structure

### Hero Section
- **Headline:** "Design Your Game with AI"
- **Subhead:** "4SAGE is a free, open framework that guides you through
  designing a game — from first idea to implementation plan — using any
  AI assistant as your game design consultant."
- **CTA:** "Get Started" → scrolls to getting started section

### What Is 4SAGE? (brief)
- 3-4 sentences: it's a methodology, not software. AI asks the right
  questions in the right order. You make the decisions. Everything is
  recorded.
- The 7-level cascade shown as a simple visual/list.

### Get Started
Three paths, clearly labeled:

#### Path 1: "I just want to chat" (easiest)
- Open any AI assistant (ChatGPT, Claude, Gemini, etc.)
- Paste this prompt: [exact prompt provided]
- Start designing

#### Path 2: "Full project with saved files" (recommended)
- Requires: Claude Code, Cursor, or similar AI coding tool
- Tell your AI: "I want to design a game using the 4SAGE framework at
  4sage.dev — set up a project for me and start the interview."
- The AI will create the project structure and begin the guided dialogue.

#### Path 3: "Voice interactive" (best experience)
- Everything in Path 2, plus you talk to your AI consultant
- Requires: microphone, speakers/headphones
- Tell your AI: "I want to use 4SAGE with voice interaction. Help me
  set up speech-to-text and text-to-speech, then start the design
  interview."
- [Link to voice setup guide]

#### For Developers
- `git clone [repo URL]`
- Read FRAMEWORK.md, CONTRIBUTING.md
- [Link to GitHub repo]

### How It Works (expandable/scroll)
- Brief explanation of the cascade: L0 → L6
- "The AI asks questions at each level. Your answers constrain the next level."
- Example snippet of a dialogue exchange

### LLM Instructions Section
This section is the key machine-readable part. It should be clearly
marked so an LLM fetching the page can find it. Use a heading like:

`## LLM Setup Instructions`

Contains:
- The complete conductor prompt (or a link to conductor.md in the repo)
- The repo URL to clone
- The project structure to create
- Step-by-step bootstrap procedure
- How to detect which tier the user needs (do they have a terminal?
  file system access? voice hardware?)

This section reads fine for humans too — it's just explicit instructions
that happen to be aimed at an AI.

### FAQ
- "Is this free?" → Yes, open source, MIT license
- "What AI do I need?" → Any — Claude, ChatGPT, Gemini, etc.
- "Do I need to know programming?" → No, but the framework covers
  implementation if you want to go there
- "Can I use this for a team project?" → Yes, the git-based project
  structure supports collaboration
- "What if the AI gives bad advice?" → The framework records decisions
  and alternatives, so you can always review the reasoning

### Footer
- GitHub repo link
- License (MIT)
- "Created by Rich" or similar attribution
- 4sage.dev

## Technical Implementation

- **Hosting options:**
  - GitHub Pages (free, auto-deploys from repo, supports custom domain)
  - VPS at cr-96-vps.com (already have nginx, would need DNS + cert)
- **Stack:** Static HTML + CSS. No build step. No JavaScript required
  (maybe minimal JS for smooth scroll or accordion).
- **DNS:** Point 4sage.dev to wherever we host.

## Content Still Needed

1. The actual "paste this prompt" for Tier 1 (condensed conductor prompt)
2. Voice setup guide (cross-platform)
3. Example dialogue snippet for the "How It Works" section
4. Final decision on hosting (GitHub Pages vs. VPS)
