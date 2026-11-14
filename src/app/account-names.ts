/**
 * The 1Password SDK finds a desktop account only by its exact name (as shown
 * at the top of the 1Password sidebar) or its account ID. It's case-sensitive
 * and treats ' and ’ as different characters (both checked against the real
 * app). A name that doesn't match fails instantly, without any prompt.
 *
 * So rather than make people get it exactly right, PaperRoute tries what they
 * typed first, then a few near-identical spellings that differ only in ways
 * people can't easily see or don't think about: capitals, curly vs straight
 * quotes, and spacing. Nothing looser than that, so it can't land on an
 * account the user didn't mean.
 */

const CURLY_TO_STRAIGHT: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‛′]/g, "'"],
  [/[“”‟″]/g, '"'],
];

/** Whitespace tidied: no-break and other odd spaces become plain ones, runs collapse, ends trimmed. */
export function tidySpaces(name: string): string {
  return name.replace(/[\s  -​  　]+/g, " ").trim();
}

function straightQuotes(name: string): string {
  return CURLY_TO_STRAIGHT.reduce((s, [pattern, plain]) => s.replace(pattern, plain), name);
}

/** macOS "smart quotes" style: an apostrophe inside or at the end of a word becomes ’. */
function curlyApostrophes(name: string): string {
  return name.replace(/'/g, "’");
}

/** Each word starting with a capital: "butcher family" → "Butcher Family". Other letters are left alone. */
function capitaliseWords(name: string): string {
  return name.replace(/(^|[\s-])(\p{Ll})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

/**
 * Names to try, most faithful first: exactly as typed (tidied), then with
 * either style of apostrophe, then each of those with words capitalised.
 * Duplicates and empty strings are removed.
 */
export function accountNameCandidates(typed: string): string[] {
  const base = tidySpaces(typed);
  if (!base) return [];
  const quoteForms = [base, straightQuotes(base), curlyApostrophes(straightQuotes(base))];
  const all = [...quoteForms, ...quoteForms.map(capitaliseWords)];
  return [...new Set(all)];
}
