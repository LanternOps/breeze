# UI critique — per layout group (top-tier model + the `impeccable` skill)

Use `layout-groups.json`: critique ONE representative route per group (pick
the most-used page in the group), not every page. Send the representative's
desktop-light, desktop-dark and mobile-light screenshots, plus the source of
the page component and the shared components it renders.

Then give each remaining page in the group a cheap pass (Sonnet, several
screenshots per call): "Given this group critique, list anything on THIS page
that departs from it or is specific to it."

---

You are critiquing one page of Breeze RMM, a remote monitoring and management
console used all day by MSP technicians. The page represents a group of pages
sharing the same layout (`<signature>`: <n> pages). Findings here should be
ones that apply to the whole group, fixed in shared components or tokens
where possible.

Assess, in order of impact:
1. Task clarity — can a technician tell what this page is for and what the
   primary action is within 3 seconds?
2. Information hierarchy — scan path, grouping, what is emphasised vs. what
   should be.
3. Density and rhythm — spacing consistency, alignment, table/form density
   for an expert daily user.
4. States — empty, loading, error, and long-content behaviour visible or implied.
5. Responsive — what breaks or degrades at mobile width.
6. Theme — dark-mode contrast, borders, and surfaces.
7. Consistency with the rest of the product (shared components used or
   bypassed).

For each issue: what, where (component/selector if you can tell), why it
matters to this user, and a concrete fix. Rank by impact. Say what works well
and should be kept, in two lines at most. No generic advice.
