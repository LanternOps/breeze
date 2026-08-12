/**
 * Shared Shadow DOM stylesheet. Static string only — nothing here may ever be
 * interpolated from API data.
 */
export const WORKSPACE_STYLES = `
:host {
  display: block;
  font-family: system-ui, -apple-system, sans-serif;
  color: inherit;
}
h1, h2 {
  font-size: 1.1rem;
  margin: 0 0 0.75rem;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  font-size: 0.9rem;
}
button {
  font: inherit;
  padding: 0.3rem 0.7rem;
  border-radius: 0.375rem;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button.danger { color: #b91c1c; border-color: #b91c1c; }
form {
  display: grid;
  gap: 0.5rem;
  max-width: 28rem;
  margin: 0.75rem 0;
}
label {
  display: grid;
  gap: 0.15rem;
  font-size: 0.85rem;
}
input, select {
  font: inherit;
  padding: 0.3rem 0.45rem;
  border-radius: 0.375rem;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent;
  color: inherit;
}
.error { color: #b91c1c; }
.muted { opacity: 0.7; }
.stats { display: grid; gap: 0.3rem; margin: 0; padding: 0; list-style: none; }
.row-actions { display: flex; gap: 0.4rem; }
.skeleton { display: inline-block; }
.ws-filing {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.5rem 0;
}
.ws-filing-label { opacity: 0.7; font-size: 0.85rem; }
.ws-filing-project { font-weight: 600; }
.ws-filing-badge {
  font-size: 0.75rem;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
}
.ws-filing-badge-high { color: #15803d; border-color: #15803d; }
.ws-filing-badge-low { color: #b45309; border-color: #b45309; }
.ws-filing-reassign { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
`;
