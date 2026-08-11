---

## Summary for Approval

### Bar
**Linear.app's dark-mode settings page design system** — exact color palette (#0A0A0B backgrounds, #7C3AED accent), Inter typography at 13px, 220px sidebar, 600px content area, specific component dimensions (32px inputs, 36x20px toggles, 6px radii).

### How the critic compares
Renders the work at 1920x1080, then scores 7 categories (First Impression, Colors, Typography, Spacing, Components, Interactions, Content) against the captured design spec. WIN requires 8+ in ALL categories; any single category below 8 is a LOSS.

### Pieces (9 tasks)

| # | Task | Files Owned | Parallel Group |
|---|------|-------------|----------------|
| 01 | Foundation & Design Tokens | `index.html`, `styles/tokens.css` | A |
| 02 | Two-Column Layout | `styles/layout.css` | A |
| 03 | Sidebar Navigation | `styles/sidebar.css`, `components/sidebar.html` | B (after 01-02) |
| 04 | Form Controls | `styles/controls.css` | A |
| 05 | Settings Cards & Sections | `styles/cards.css` | A |
| 06 | Profile Section | `sections/profile.html`, `styles/profile.css` | C (after 04-05) |
| 07 | Preferences Section | `sections/preferences.html`, `styles/preferences.css` | C |
| 08 | Account Section | `sections/account.html`, `styles/account.css` | C |
| 09 | Final Assembly & Polish | `scripts/main.js`, updates to `index.html` | D (after all) |

**Parallel strategy**: Tasks 01, 02, 04, 05 run in parallel (Group A). Task 03 follows (needs foundation). Tasks 06, 07, 08 run in parallel (Group C, needs controls/cards). Task 09 assembles everything.

---

Reply **"go"** to begin the build loop.
