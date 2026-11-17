# Staff portal and Registrar dashboard redesign

| | |
|---|---|
| **Related backlog item** | PB-09 Manage Enrollment Application (UI refresh, no new scope) |
| **Merged** | Fork PR #7, Nov 18, 2026 (live on https://manage-enrollment-application.vercel.app) |
| **Author** | Gian Mandac |
| **Type of change** | User interface only. No database, RPC, edge function or API changes |

## Why
The first Registrar screens worked but were plain: a very large page title, a basic table
and a pop-up dialog. The redesign makes the portal look like the school's own (maroon and
gold with the SNCS seal) and shows the Registrar what needs attention as soon as the page
opens.

## What changed

### Staff portal bar (all staff dashboards)
`src/views/StaffDashboardView.vue`

- Maroon bar with a gold rule, the SNCS seal, the school name and the page name
  (for example *Registrar dashboard*).
- The signed-in staff member's name, initials and role. The name comes from the account
  details the Admin entered (`app_metadata.chimera_staff_provisioning.full_name`); if it is
  missing, the email is shown.
- *School website* link and *Sign out* button. Sign-out and session-expiry behaviour are
  unchanged.
- Applies to the Admin, Registrar and Teacher dashboards so the portal looks the same for
  every role.

### Registrar dashboard
`src/components/RegistrarApplicationsPanel.vue`

| Part | What it does |
|---|---|
| Greeting | "Good evening, Ana. Today is …" using Asia/Manila time |
| Workload headline | For example "4 new applications to review", then how long the oldest one has waited. Falls back to "applications in review" or "You're all caught up" |
| Status pipeline | Pending → For review → Complete / Incomplete with counts. Choosing a tile filters the list; choosing it again clears the filter. Totals above one page show as "25+" |
| Live refresh | The list and counts reload every minute while the tab is visible. Paused while an application is open so the list never moves under the Registrar. "Updated … ago" label and a Refresh button |
| Search and filters | Same fields as before (name or reference, status, submitted from/to) |
| Application list | Initials, full name with reference number, grade and status tags, "3 days ago" with the exact date. The whole row opens the review; the Review button still works |
| Loading and empty states | Placeholder rows while loading; "Show all applications" when filters match nothing |
| Phones | The table becomes stacked rows; no sideways scrolling |

### Review panel
`src/components/RegistrarApplicationDetail.vue`

- Slides in from the right instead of a centred pop-up. Escape or clicking the dimmed
  background closes it; keyboard focus moves into the panel and the page behind stops
  scrolling.
- Header: applicant name, reference number, grade and applicant type, submitted date,
  status badge, Previous / Next / Close.
- Requirements progress bar ("2 of 8 received"); it turns green when all required items
  are in.
- Two columns on wide screens: applicant details on the left; a sticky action rail on the
  right with the requirement checklist, status and remarks, the email preview and the
  print buttons. One column on phones.

## What did not change
- Saving a status still needs the confirmation step; Cancel keeps the old status.
- The status email is still never automatic: the Registrar previews it and confirms.
- Checklist saving, search, paging, Previous/Next, the A4 verification form and its
  layout, sign-in, sign-out and session expiry work as before.
- Every request still goes through the role-checked database functions.

## Data used by the new parts
The counts reuse the existing `search_registrar_applications` function, once per status,
through `countApplicationsByStatus()` in `src/lib/enrollment/registrar.ts`. They are
read-only. With live refresh this is five small requests a minute per open Registrar
dashboard.

## Accessibility
- Status is shown with text as well as colour.
- Visible gold focus outlines; tiles use `aria-pressed`; the progress bar uses
  `role="progressbar"` with current and maximum values.
- Animations (live dot, loading placeholders, panel slide) are turned off when the device
  asks for reduced motion.

## Tests
`pnpm test`: 24 files, 285 tests. New tests:

- `src/components/StaffPortalPanels.test.ts`: status counts and headline, tile filtering
  and clearing, "25+" for more than one page.
- `src/views/StaffDashboardView.test.ts`: SNCS seal, signed-in name and initials.
- `src/components/RegistrarApplicationDetail.test.ts`: applicant name heading, progress
  bar value, closing from the backdrop.

Also checked in a browser with sample data at 1360 px and 390 px wide: no horizontal
overflow, correct counts, and the review panel opens with focus inside it.

## Undo
Revert the merge commit of fork PR #7 (`git revert -m 1 ce70aec`) and redeploy. No
database changes need undoing.
