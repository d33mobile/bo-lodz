// Branch-coverage unit tests for the pure logic in ../logic.js.
// These mirror the original inline semantics; no DOM is involved.
import { describe, it, expect } from "vitest";
import {
  esc,
  fmtCost,
  csvCell,
  projectPasses,
  compareProjects,
  dataSig,
  moveExtreme,
  swapAdjacent,
  osiedlaMap,
  popUndo,
  gzipB64,
  gunzipB64,
} from "../logic.js";

// Minimal project factory with sane defaults; override per test.
function proj(over = {}) {
  return {
    numer: "1",
    tytul: "Park",
    typ: "OSIEDLOWE",
    kategoria: "zielen",
    dzielnica: "Bałuty",
    osiedle: "Bałuty-Doły",
    opinia_rm: "POZYTYWNA",
    opis: "opis parku",
    koszt: 100000,
    ...over,
  };
}

// Empty filter state — every field off so a project passes by default.
function blankState(over = {}) {
  return {
    preset: "all",
    cat: "",
    dist: "",
    osiedle: "",
    negonly: false,
    hideseen: false,
    q: "",
    sort: "num",
    ...over,
  };
}

const ctx = (over = {}) => ({ fav: new Set(), sharedSet: new Set(), seen: new Set(), ...over });

describe("esc", () => {
  it("escapes the special HTML characters", () => {
    expect(esc('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
  it("returns empty string for null/undefined (falsy branch)", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc("")).toBe("");
  });
});

describe("fmtCost", () => {
  it("returns an em dash for null/undefined (missing branch)", () => {
    expect(fmtCost(null)).toBe("—");
    expect(fmtCost(undefined)).toBe("—");
  });
  it("formats a number with a zł suffix (value branch)", () => {
    const out = fmtCost(1234567);
    expect(out).toContain("zł");
    // 0 is a valid cost and must NOT be treated as missing.
    expect(fmtCost(0)).toContain("zł");
    expect(fmtCost(0)).not.toBe("—");
  });
});

describe("csvCell", () => {
  it("returns empty string for null/undefined (nullish branch)", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("leaves plain values unquoted (no special chars branch)", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(42)).toBe("42");
  });
  it("quotes and doubles inner quotes for special chars (quoting branch)", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("projectPasses", () => {
  it("passes with a blank state and empty context", () => {
    expect(projectPasses(blankState(), proj(), ctx(), false)).toBe(true);
  });

  describe("preset", () => {
    it("pon: rejects non-PONADOSIEDLOWE, accepts PONADOSIEDLOWE", () => {
      const s = blankState({ preset: "pon" });
      expect(projectPasses(s, proj({ typ: "OSIEDLOWE" }), ctx(), false)).toBe(false);
      expect(projectPasses(s, proj({ typ: "PONADOSIEDLOWE" }), ctx(), false)).toBe(true);
    });
    it("fav: rejects when not in fav set, accepts when in it", () => {
      const s = blankState({ preset: "fav" });
      expect(projectPasses(s, proj({ numer: "7" }), ctx(), false)).toBe(false);
      expect(projectPasses(s, proj({ numer: "7" }), ctx({ fav: new Set(["7"]) }), false)).toBe(
        true
      );
    });
    it("shared: rejects when not in shared set, accepts when in it", () => {
      const s = blankState({ preset: "shared" });
      expect(projectPasses(s, proj({ numer: "9" }), ctx(), false)).toBe(false);
      expect(
        projectPasses(s, proj({ numer: "9" }), ctx({ sharedSet: new Set(["9"]) }), false)
      ).toBe(true);
    });
  });

  it("cat filter: rejects mismatch, accepts match", () => {
    expect(
      projectPasses(blankState({ cat: "sport" }), proj({ kategoria: "zielen" }), ctx(), false)
    ).toBe(false);
    expect(
      projectPasses(blankState({ cat: "zielen" }), proj({ kategoria: "zielen" }), ctx(), false)
    ).toBe(true);
  });

  it("dist filter: rejects mismatch, accepts match", () => {
    expect(
      projectPasses(blankState({ dist: "Górna" }), proj({ dzielnica: "Bałuty" }), ctx(), false)
    ).toBe(false);
    expect(
      projectPasses(blankState({ dist: "Bałuty" }), proj({ dzielnica: "Bałuty" }), ctx(), false)
    ).toBe(true);
  });

  it("osiedle filter: rejects mismatch, accepts match", () => {
    expect(projectPasses(blankState({ osiedle: "X" }), proj({ osiedle: "Y" }), ctx(), false)).toBe(
      false
    );
    expect(projectPasses(blankState({ osiedle: "Y" }), proj({ osiedle: "Y" }), ctx(), false)).toBe(
      true
    );
  });

  describe("negonly", () => {
    it("rejects non-negative opinion", () => {
      expect(
        projectPasses(blankState({ negonly: true }), proj({ opinia_rm: "POZYTYWNA" }), ctx(), false)
      ).toBe(false);
    });
    it("rejects when opinia_rm is missing (nullish branch)", () => {
      expect(
        projectPasses(blankState({ negonly: true }), proj({ opinia_rm: null }), ctx(), false)
      ).toBe(false);
    });
    it("accepts a NEGATYWNA opinion", () => {
      expect(
        projectPasses(
          blankState({ negonly: true }),
          proj({ opinia_rm: "NEGATYWNA — uwagi" }),
          ctx(),
          false
        )
      ).toBe(true);
    });
  });

  describe("hideseen", () => {
    it("rejects a seen project when hideseen is on", () => {
      const s = blankState({ hideseen: true });
      expect(projectPasses(s, proj({ numer: "5" }), ctx({ seen: new Set(["5"]) }), false)).toBe(
        false
      );
    });
    it("ignoreSeen=true bypasses the hide-seen rule", () => {
      const s = blankState({ hideseen: true });
      expect(projectPasses(s, proj({ numer: "5" }), ctx({ seen: new Set(["5"]) }), true)).toBe(
        true
      );
    });
    it("accepts an unseen project even with hideseen on", () => {
      const s = blankState({ hideseen: true });
      expect(projectPasses(s, proj({ numer: "5" }), ctx({ seen: new Set() }), false)).toBe(true);
    });
    it("fav view: seen projects are NOT hidden (preset exception)", () => {
      const s = blankState({ preset: "fav", hideseen: true });
      const c = ctx({ fav: new Set(["5"]), seen: new Set(["5"]) });
      expect(projectPasses(s, proj({ numer: "5" }), c, false)).toBe(true);
    });
    it("shared view: seen projects are NOT hidden (preset exception)", () => {
      const s = blankState({ preset: "shared", hideseen: true });
      const c = ctx({ sharedSet: new Set(["5"]), seen: new Set(["5"]) });
      expect(projectPasses(s, proj({ numer: "5" }), c, false)).toBe(true);
    });
  });

  describe("query", () => {
    it("matches on title (case-insensitive)", () => {
      expect(
        projectPasses(blankState({ q: "PARK" }), proj({ tytul: "Park Miejski" }), ctx(), false)
      ).toBe(true);
    });
    it("matches on numer", () => {
      expect(
        projectPasses(blankState({ q: "123" }), proj({ numer: "B123", tytul: "z" }), ctx(), false)
      ).toBe(true);
    });
    it("matches on opis", () => {
      expect(
        projectPasses(
          blankState({ q: "rower" }),
          proj({ tytul: "z", numer: "1", opis: "ścieżka rowerowa" }),
          ctx(),
          false
        )
      ).toBe(true);
    });
    it("rejects when no field matches", () => {
      expect(
        projectPasses(
          blankState({ q: "xyzzy" }),
          proj({ tytul: "z", numer: "1", opis: "abc" }),
          ctx(),
          false
        )
      ).toBe(false);
    });
    it("handles a missing opis (nullish branch)", () => {
      expect(
        projectPasses(
          blankState({ q: "park" }),
          proj({ tytul: "Park", numer: "1", opis: null }),
          ctx(),
          false
        )
      ).toBe(true);
    });
  });
});

describe("compareProjects", () => {
  it("sort=cost: ascending, null koszt sinks to the end", () => {
    const s = blankState({ sort: "cost" });
    expect(compareProjects(s, proj({ koszt: 100 }), proj({ koszt: 200 }))).toBeLessThan(0);
    // null is treated as 9e15 (very large) → sorts after a real cost.
    expect(compareProjects(s, proj({ koszt: null }), proj({ koszt: 200 }))).toBeGreaterThan(0);
  });
  it("sort=costd: descending, null koszt sinks to the end", () => {
    const s = blankState({ sort: "costd" });
    expect(compareProjects(s, proj({ koszt: 200 }), proj({ koszt: 100 }))).toBeLessThan(0);
    // null is treated as -1 → sorts after a real cost in descending order.
    expect(compareProjects(s, proj({ koszt: null }), proj({ koszt: 200 }))).toBeGreaterThan(0);
  });
  it("sort=num (default): natural numeric numer order", () => {
    const s = blankState({ sort: "num" });
    expect(compareProjects(s, proj({ numer: "2" }), proj({ numer: "10" }))).toBeLessThan(0);
  });
  it("sort=manual/shared/unknown falls through to the numer default", () => {
    const s = blankState({ sort: "manual" });
    expect(compareProjects(s, proj({ numer: "2" }), proj({ numer: "10" }))).toBeLessThan(0);
    const s2 = blankState({ sort: "shared" });
    expect(compareProjects(s2, proj({ numer: "10" }), proj({ numer: "2" }))).toBeGreaterThan(0);
  });
});

describe("dataSig", () => {
  it("joins count, project length and serialized length", () => {
    const sig = dataSig({ count: 3, projects: [{ a: 1 }, { a: 2 }] });
    const parts = sig.split("|");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("3");
    expect(parts[1]).toBe("2");
  });
  it("changes when a field is added/edited", () => {
    const a = dataSig({ count: 1, projects: [{ x: 1 }] });
    const b = dataSig({ count: 1, projects: [{ x: 1, y: 2 }] });
    expect(a).not.toBe(b);
  });
  it("handles missing projects (nullish branches)", () => {
    const sig = dataSig({ count: 0 });
    expect(sig.split("|")[1]).toBe("0");
  });
});

describe("moveExtreme", () => {
  it("toEnd=false moves n to the front", () => {
    expect(moveExtreme(["a", "b", "c"], "c", false)).toEqual(["c", "a", "b"]);
  });
  it("toEnd=true moves n to the end", () => {
    expect(moveExtreme(["a", "b", "c"], "a", true)).toEqual(["b", "c", "a"]);
  });
  it("does not mutate the input array", () => {
    const order = ["a", "b", "c"];
    moveExtreme(order, "a", true);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("swapAdjacent", () => {
  it("swaps a project with an existing neighbour", () => {
    expect(swapAdjacent(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
  });
  it("returns a new array (no mutation)", () => {
    const order = ["a", "b", "c"];
    const out = swapAdjacent(order, "b", "c");
    expect(out).toEqual(["a", "c", "b"]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("osiedlaMap", () => {
  it("builds dzielnica -> sorted unique osiedla", () => {
    const map = osiedlaMap([
      proj({ dzielnica: "Bałuty", osiedle: "Doły" }),
      proj({ dzielnica: "Bałuty", osiedle: "Arturówek" }),
      proj({ dzielnica: "Bałuty", osiedle: "Doły" }), // duplicate
      proj({ dzielnica: "Górna", osiedle: "Chojny" }),
    ]);
    expect(map["Bałuty"]).toEqual(["Arturówek", "Doły"]);
    expect(map["Górna"]).toEqual(["Chojny"]);
  });
  it("skips entries missing dzielnica or osiedle (falsy branches)", () => {
    const map = osiedlaMap([
      proj({ dzielnica: "", osiedle: "X" }),
      proj({ dzielnica: "Y", osiedle: "" }),
      proj({ dzielnica: "Z", osiedle: "Q" }),
    ]);
    expect(map).toEqual({ Z: ["Q"] });
  });
});

describe("popUndo", () => {
  it("empty stack → { numer: null, stack: [] }", () => {
    expect(popUndo([], new Set())).toEqual({ numer: null, stack: [] });
  });
  it("top entry still seen → returns it and the remaining stack", () => {
    const res = popUndo(["1", "2", "3"], new Set(["1", "2", "3"]));
    expect(res.numer).toBe("3");
    expect(res.stack).toEqual(["1", "2"]);
  });
  it("skips entries no longer in seen, returns the first that is", () => {
    // "3" was manually unchecked → skip it, pop "2" which is still seen.
    const res = popUndo(["1", "2", "3"], new Set(["1", "2"]));
    expect(res.numer).toBe("2");
    expect(res.stack).toEqual(["1"]);
  });
  it("all entries unchecked → { numer: null, stack: [] }", () => {
    expect(popUndo(["1", "2"], new Set())).toEqual({ numer: null, stack: [] });
  });
  it("does not mutate the input stack", () => {
    const stack = ["1", "2"];
    popUndo(stack, new Set(["1", "2"]));
    expect(stack).toEqual(["1", "2"]);
  });
});

describe("gzipB64 / gunzipB64 round-trip", () => {
  it("recovers the original string", async () => {
    const original = JSON.stringify({ order: ["1", "2", "3"], note: "Łódź ąćęź" });
    const packed = await gzipB64(original);
    // base64url: no +, /, or = padding.
    expect(packed).not.toMatch(/[+/=]/);
    const restored = await gunzipB64(packed);
    expect(restored).toBe(original);
  });
  it("round-trips an empty string", async () => {
    expect(await gunzipB64(await gzipB64(""))).toBe("");
  });
});
