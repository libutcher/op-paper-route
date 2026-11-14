import { describe, expect, it } from "vitest";
import { accountNameCandidates, tidySpaces } from "./account-names.js";

describe("tidySpaces", () => {
  it("trims, collapses runs, and turns no-break and odd spaces into plain ones", () => {
    expect(tidySpaces("  Butcher   Family \n")).toBe("Butcher Family");
    expect(tidySpaces("Butcher Family")).toBe("Butcher Family");
    expect(tidySpaces("Butcher Family")).toBe("Butcher Family");
    expect(tidySpaces(" \t ")).toBe("");
  });
});

describe("accountNameCandidates", () => {
  it("tries exactly what was typed first", () => {
    expect(accountNameCandidates("Butcher Family")[0]).toBe("Butcher Family");
    expect(accountNameCandidates("butcher family")[0]).toBe("butcher family");
  });

  it("offers a capitalised version for a name typed in lower case", () => {
    expect(accountNameCandidates("butcher family")).toEqual(["butcher family", "Butcher Family"]);
  });

  it("offers both apostrophe styles, since macOS often curls them as you type", () => {
    expect(accountNameCandidates("Lucy's Family")).toEqual(["Lucy's Family", "Lucy’s Family"]);
    expect(accountNameCandidates("Lucy’s Family")).toEqual(["Lucy’s Family", "Lucy's Family"]);
  });

  it("combines the two: a lower-case name with a straight apostrophe", () => {
    expect(accountNameCandidates("lucy's family")).toEqual([
      "lucy's family",
      "lucy’s family",
      "Lucy's Family",
      "Lucy’s Family",
    ]);
  });

  it("tidies spacing before anything else", () => {
    expect(accountNameCandidates("  Butcher  Family ")).toEqual(["Butcher Family"]);
  });

  it("leaves other capitals alone (no lower-casing, no guessing)", () => {
    expect(accountNameCandidates("ACME Corp")).toEqual(["ACME Corp"]);
    expect(accountNameCandidates("my McDonald family")).toEqual(["my McDonald family", "My McDonald Family"]);
  });

  it("capitalises words after a hyphen too", () => {
    expect(accountNameCandidates("smith-jones")).toEqual(["smith-jones", "Smith-Jones"]);
  });

  it("returns nothing for an empty or blank name", () => {
    expect(accountNameCandidates("")).toEqual([]);
    expect(accountNameCandidates("   ")).toEqual([]);
  });

  it("never returns duplicates", () => {
    for (const name of ["Work", "work", "it's", "Already Fine", "  spaced  out  "]) {
      const candidates = accountNameCandidates(name);
      expect(new Set(candidates).size, name).toBe(candidates.length);
    }
  });
});
