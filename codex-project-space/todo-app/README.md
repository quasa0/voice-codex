# Iterative Todo App

This repo provides a simple front-end-only todo experience with an emphasis on iterative improvement. Each section in the UI (form, filters, summary, list) represents a small step in the design process so you can expand or refactor confidently.

## Highlights
- **Persistent storage:** Tasks survive refreshes via `localStorage`.
- **Prioritized queue:** Tasks sort by priority and recency so the most important items surface first.
- **Filters:** Switch between All, Done, and Pending views for clarity during each iteration.
- **Counts:** Totals and done/pending numbers update automatically to keep progress visible.
- **Accessible controls:** Labels and `aria-live` areas keep the experience usable across tooling.

## Iteration Notes
1. **Base iteration:** HTML form with input and select, button to add tasks. List renders with minimal styling.
2. **Second iteration:** Added filters, summary cards, accessible labels, and responsive layout tweaks.
3. **Third iteration:** Introduced priority chips, localStorage persistence, and visual polish (gradients, rounded panels).

## Usage
1. Open `todo-app/index.html` in a browser.
2. Add tasks by naming them and picking a priority.
3. Use filter buttons to inspect different task states.
4. Check summary counters to assess progress before shipping the next iteration.

Feel free to continue iterating with drag-and-drop ordering, due dates, or syncing to a backend as a next step!
