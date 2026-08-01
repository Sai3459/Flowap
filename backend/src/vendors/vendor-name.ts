/**
 * Vendor name normalisation. Pure, so the rules are testable without a database.
 *
 * This exists because of a money bug, not tidiness. Duplicate detection gates on `vendorId`,
 * and vendor resolution used to be exact-name — so "Arena Media Comunicaciones España, S.A."
 * and "ARENA MEDIA COMUNICACIONES ESPANA S.A" became two vendor rows, and the duplicate check
 * silently stopped seeing invoices from those two as related. The failure mode is paying the
 * same invoice twice, with nothing on screen to suggest anything went wrong.
 *
 * The real invoices this system has processed are exactly the shape that fragments: accented
 * characters, punctuation, and a legal-form suffix.
 *
 * What normalisation is for, and what it is not: it decides whether two spellings are the
 * *same company*, so it is deliberately aggressive about noise (case, accents, punctuation,
 * legal form, "the"). It is **not** fuzzy matching — "Acme Supplies" and "Acme Supply Co"
 * stay distinct, because guessing that two similar names are one company can merge two real
 * suppliers and send money to the wrong bank account. Aggressive on noise, conservative on
 * meaning.
 */

/**
 * Legal-form suffixes, stripped only when they appear at the end. A supplier prints these
 * inconsistently — with dots, without, before or after a comma — and none of it identifies
 * a different company.
 *
 * Ordered longest-first so "S.L.U" is consumed before "S.L".
 */
const LEGAL_SUFFIXES = [
  // Iberian
  'sociedad limitada', 'sociedad anonima', 'slu', 'sl', 'sa', 'sau', 'sc', 'scp', 'sll',
  // Italian
  'srls', 'srl', 'spa', 'sas', 'snc',
  // French / Benelux
  'sarl', 'eurl', 'sasu', 'bvba', 'bv', 'nv', 'cv',
  // German-speaking
  'gmbh und co kg', 'gmbh co kg', 'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug', 'gbr',
  // UK / US / IE
  'limited', 'ltd', 'llc', 'llp', 'lp', 'plc', 'incorporated', 'inc', 'corporation',
  'corp', 'company', 'co',
  // Nordics
  'aktiebolag', 'ab', 'oyj', 'oy', 'as', 'asa', 'aps', 'ans',
  // Other
  'pty', 'pte', 'bhd', 'sdn', 'zoo', 'sp z oo', 'doo', 'dooel', 'kft', 'sro',
];

/** Latin-1/Latin-A characters that NFD does not decompose into base + combining mark. */
const NON_DECOMPOSING: Record<string, string> = {
  ß: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ø: 'o', Ø: 'o', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd', þ: 'th', Þ: 'th', ł: 'l', Ł: 'l',
};

/**
 * The key two spellings must share to be treated as the same vendor.
 *
 * Returns '' when the input carries no identifying content at all (empty, or punctuation
 * only). Callers must treat '' as "cannot resolve" rather than as a valid key — otherwise
 * every unnameable vendor would collapse into one row.
 */
export function normaliseVendorName(raw: string): string {
  if (!raw) return '';

  let s = raw.normalize('NFD');
  // Strip combining marks: España -> Espana, Gavà -> Gava.
  s = s.replace(/[̀-ͯ]/g, '');
  s = s.replace(/[ßæÆœŒøØđĐðÐþÞłŁ]/g, (c) => NON_DECOMPOSING[c] ?? c);
  s = s.toLowerCase();

  // Ampersand is a spelling of "and", not a separator: "Smith & Sons" == "Smith and Sons".
  s = s.replace(/&/g, ' and ');
  // Dots and apostrophes are *removed*, not turned into spaces, so a dotted abbreviation
  // collapses into one token: "S.A." -> "sa", "B.V." -> "bv", "S.r.l." -> "srl". Turning them
  // into spaces instead left "s a", which then matched no legal suffix and survived into the
  // key — which is how the very first real vendor name failed.
  s = s.replace(/['’.]/g, '');
  // Everything else non-alphanumeric becomes a space.
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();

  // Leading article carries no identity: "The Acme Company" == "Acme".
  s = s.replace(/^the /, '');

  s = stripTrailingLegalSuffixes(s);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Removes legal-form words from the end, repeatedly — "Foo Holdings GmbH & Co KG" sheds both
 * parts. Never strips the whole name: a supplier legitimately called "Company" keeps it,
 * because a vendor with an empty key would collide with every other unnameable vendor.
 */
function stripTrailingLegalSuffixes(input: string): string {
  // Connectives left dangling once the thing they joined is gone: "GmbH & Co KG" sheds
  // "kg" then "co", leaving "... and", which is not part of anyone's name. Only stripped
  // when trailing, so "Smith and Sons" keeps its "and".
  const trailingConnectives = ['and', 'und', 'y', 'e'];
  let s = input;

  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of [...LEGAL_SUFFIXES, ...trailingConnectives]) {
      if (s === suffix) return s; // the name *is* the suffix — leave it alone
      if (s.endsWith(` ${suffix}`)) {
        const candidate = s.slice(0, -(suffix.length + 1)).trim();
        if (candidate) {
          s = candidate;
          changed = true;
          break;
        }
      }
    }
  }
  return s;
}

/** True when two spellings denote the same vendor under these rules. */
export function isSameVendorName(a: string, b: string): boolean {
  const ka = normaliseVendorName(a);
  return ka !== '' && ka === normaliseVendorName(b);
}
