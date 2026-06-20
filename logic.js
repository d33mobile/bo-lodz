// Pure logic for BO Łódź — no DOM access. The DOM layer lives in app.js and
// passes the current state/sets in as arguments so these functions stay testable
// in isolation. Semantics here must match the original inline implementation 1:1.

// HTML-escape a string for safe interpolation into innerHTML.
export function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Format a cost in PLN, or an em dash when it's missing.
export function fmtCost(c) {
  if (c == null) return "—";
  return c.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " zł";
}

// CSV cell with RFC-style quoting (semicolon-delimited dialect).
export function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Whether project p passes the active filters in `state`.
// ctx = { fav:Set, sharedSet:Set, seen:Set }. ignoreSeen skips the hide-seen rule.
export function projectPasses(state, p, ctx, ignoreSeen) {
  const { fav, sharedSet, seen } = ctx;
  if (state.preset === "pon" && p.typ !== "PONADOSIEDLOWE") return false;
  if (state.preset === "fav" && !fav.has(p.numer)) return false;
  if (state.preset === "shared" && !sharedSet.has(p.numer)) return false;
  if (state.cat && p.kategoria !== state.cat) return false;
  if (state.dist && p.dzielnica !== state.dist) return false;
  if (state.osiedle && p.osiedle !== state.osiedle) return false;
  if (state.negonly && !(p.opinia_rm || "").startsWith("NEGATYWNA")) return false;
  // "hide seen" never applies in the favourites or shared views
  if (
    !ignoreSeen &&
    state.hideseen &&
    state.preset !== "fav" &&
    state.preset !== "shared" &&
    seen.has(p.numer)
  )
    return false;
  if (state.q) {
    const q = state.q.toLowerCase();
    if (
      !(
        p.tytul.toLowerCase().includes(q) ||
        p.numer.toLowerCase().includes(q) ||
        (p.opis || "").toLowerCase().includes(q)
      )
    )
      return false;
  }
  return true;
}

// Comparator for the active sort. For the manual/shared orderings the caller
// sorts by favOrder/shared index directly; this covers num/cost/costd.
export function compareProjects(state, a, b) {
  switch (state.sort) {
    case "cost":
      return (a.koszt ?? 9e15) - (b.koszt ?? 9e15);
    case "costd":
      return (b.koszt ?? -1) - (a.koszt ?? -1);
    default:
      return a.numer.localeCompare(b.numer, "pl", { numeric: true });
  }
}

// content-sensitive signature: the serialized length changes whenever any field
// is added/edited, so adding e.g. opinia_rm correctly invalidates the cache.
export function dataSig(d) {
  return [d.count, (d.projects || []).length, JSON.stringify(d.projects || []).length].join("|");
}

// Move numer n to the very start (toEnd=false) or end (toEnd=true) of order.
// Returns a new array; does not mutate the input.
export function moveExtreme(order, n, toEnd) {
  const arr = order.filter((x) => x !== n);
  if (toEnd) arr.push(n);
  else arr.unshift(n);
  return arr;
}

// Swap numer n with its neighbour in order. Returns a new array.
export function swapAdjacent(order, n, neighbour) {
  const arr = order.slice();
  const a = arr.indexOf(n);
  const c = arr.indexOf(neighbour);
  [arr[a], arr[c]] = [arr[c], arr[a]];
  return arr;
}

// Build dzielnica -> sorted unique [osiedle] map from the projects list.
export function osiedlaMap(projects) {
  const map = {};
  projects.forEach((p) => {
    if (p.dzielnica && p.osiedle) (map[p.dzielnica] ||= []).push(p.osiedle);
  });
  for (const k in map) map[k] = [...new Set(map[k])].sort((a, b) => a.localeCompare(b, "pl"));
  return map;
}

// compact share payload: gzip + base64url
export async function gzipB64(str) {
  const cs = new CompressionStream("gzip");
  const buf = await new Response(new Blob([str]).stream().pipeThrough(cs)).arrayBuffer();
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function gunzipB64(b64) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  return await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}
