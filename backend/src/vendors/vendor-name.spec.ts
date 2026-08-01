import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isSameVendorName, normaliseVendorName } from './vendor-name';

describe('normaliseVendorName — the real suppliers this system has processed', () => {
  it('collapses the spellings of Arena Media that would otherwise fragment', () => {
    // Straight off the PDF, versus how the same name arrives typed by a human or
    // transliterated by an extractor that drops accents.
    const spellings = [
      'Arena Media Comunicaciones España, S.A.',
      'ARENA MEDIA COMUNICACIONES ESPAÑA , S.A',
      'Arena Media Comunicaciones Espana SA',
      'arena media comunicaciones españa, s.a.',
    ];
    const keys = new Set(spellings.map(normaliseVendorName));
    assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(' | ')}`);
    assert.equal([...keys][0], 'arena media comunicaciones espana');
  });

  it('collapses the spellings of Ready4people', () => {
    assert.ok(isSameVendorName('Ready4people Development, S.L.', 'READY4PEOPLE DEVELOPMENT SL'));
    assert.equal(normaliseVendorName('Ready4people Development, S.L.'), 'ready4people development');
  });

  it('handles the classic case the old exact-match lost money on', () => {
    // Duplicate detection gates on vendorId, so these becoming two rows meant the same
    // invoice could be paid twice with nothing on screen to suggest a problem.
    assert.ok(isSameVendorName('Acme Inc.', 'Acme, Inc'));
    assert.ok(isSameVendorName('Acme Inc.', 'ACME INCORPORATED'));
  });
});

describe('normaliseVendorName — noise it should remove', () => {
  it('strips accents and non-decomposing characters', () => {
    assert.equal(normaliseVendorName('Gavà Serveis'), 'gava serveis');
    assert.equal(normaliseVendorName('Müller Straße'), 'muller strasse');
    assert.equal(normaliseVendorName('Ø-Design'), 'o design');
  });

  it('treats & and "and" as the same word', () => {
    assert.ok(isSameVendorName('Smith & Sons Ltd', 'Smith and Sons Limited'));
  });

  it('ignores a leading article', () => {
    assert.ok(isSameVendorName('The Acme Company', 'Acme'));
  });

  it('sheds stacked legal forms', () => {
    assert.equal(normaliseVendorName('Foo Holdings GmbH & Co KG'), 'foo holdings');
    assert.equal(normaliseVendorName('Bar Trading B.V.'), 'bar trading');
    assert.equal(normaliseVendorName('Baz S.r.l.'), 'baz');
  });

  it('is insensitive to spacing and punctuation noise', () => {
    assert.ok(isSameVendorName('  Northwind   Traders  ', 'Northwind-Traders'));
  });
});

describe('normaliseVendorName — distinctions it must preserve', () => {
  it('does not merely fuzzy-match similar names', () => {
    // Merging two genuinely different suppliers is worse than splitting one: it points
    // payments at the wrong bank account. Aggressive on noise, conservative on meaning.
    assert.ok(!isSameVendorName('Acme Supplies', 'Acme Supply Co'));
    assert.ok(!isSameVendorName('Northwind Traders', 'Northwind Trading'));
    assert.ok(!isSameVendorName('Arena Media', 'Arena Medical'));
  });

  it('keeps numbers, which are often the distinguishing part', () => {
    assert.ok(!isSameVendorName('Studio 54 Ltd', 'Studio 55 Ltd'));
    assert.equal(normaliseVendorName('Ready4people'), 'ready4people');
  });

  it('never strips a name down to nothing', () => {
    // A supplier really called "Company" must keep a usable key, or every unnameable
    // vendor would collide into one row.
    assert.equal(normaliseVendorName('Company'), 'company');
    assert.equal(normaliseVendorName('S.A.'), 'sa');
  });

  it('returns empty for input with no identifying content, so callers can refuse it', () => {
    assert.equal(normaliseVendorName(''), '');
    assert.equal(normaliseVendorName('   '), '');
    assert.equal(normaliseVendorName('--- ,. ---'), '');
    assert.equal(isSameVendorName('', ''), false, 'two unnameable vendors are not the same vendor');
  });
});
