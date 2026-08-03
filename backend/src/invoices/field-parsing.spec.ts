/**
 * Parsing rules for corrected field values, driven by two real invoices.
 *
 * Both documents are Spanish suppliers billing an Italian customer, and both broke the
 * original parsers:
 *
 *   Arena Media Comunications España, S.A. — invoice 2026001293, 04/05/2026,
 *     due 03/06/2026, EUR 10.000,00, 0% VAT (intra-EU reverse charge)
 *   Ready4people Development, S.L. — factura 260011, 23/01/2026, due 22/02/2026,
 *     EUR 800,00, VAT rate table printed (21/10/4) but nothing charged
 *
 * Every value below is copied from those documents as printed. That is the point: the old
 * code was written against invented fixtures that all happened to use US conventions, so it
 * passed its tests and would have corrupted the first real European invoice it saw.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CORRECTABLE_FIELDS } from './invoices.service';

const money = (raw: string) => CORRECTABLE_FIELDS.subtotal.parse(raw) as string;
const date = (raw: string) => CORRECTABLE_FIELDS.invoiceDate.parse(raw) as Date;
const iso = (raw: string) => date(raw).toISOString().slice(0, 10);

describe('date parsing — the silent-corruption regression', () => {
  it('reads a European date day-first, as the document means it', () => {
    // Arena Media, DATE: 04/05/2026 = 4 May 2026. `new Date('04/05/2026')` returned
    // 5 April — wrong by a month, with no error anywhere.
    assert.equal(iso('04/05/2026'), '2026-05-04');
  });

  it('keeps a due date after its invoice date', () => {
    // Same invoice: due 03/06/2026 = 3 June. The old parser made it 6 March, i.e. three
    // months *before* the invoice date, which reads as long overdue and drives a wrong
    // payment run.
    assert.ok(date('03/06/2026') > date('04/05/2026'));
  });

  it('accepts a day above 12, which used to throw', () => {
    // Ready4people, FECHA 23/01/2026. There is no month 23, so `new Date` returned Invalid
    // Date and the endpoint answered 400. Roughly half the year failed loudly while the
    // other half corrupted silently.
    assert.equal(iso('23/01/2026'), '2026-01-23');
    assert.equal(iso('22/02/2026'), '2026-02-22');
  });

  it('accepts ISO, which is what extraction and a date picker send', () => {
    assert.equal(iso('2026-05-04'), '2026-05-04');
  });

  it('accepts dot and dash separators too', () => {
    assert.equal(iso('04.05.2026'), '2026-05-04');
    assert.equal(iso('04-05-2026'), '2026-05-04');
  });

  it('rejects an impossible calendar date instead of rolling it over', () => {
    // Date would happily turn 31 February into 3 March.
    assert.throws(() => date('31/02/2026'), /not a real date/);
    assert.throws(() => date('00/01/2026'), /not a real date/);
  });

  it('rejects anything it cannot read, rather than guessing', () => {
    assert.throws(() => date('May 4 2026'), /YYYY-MM-DD or DD\/MM\/YYYY/);
    assert.throws(() => date('2026/05/04'), /YYYY-MM-DD or DD\/MM\/YYYY/);
    assert.throws(() => date(''), /YYYY-MM-DD or DD\/MM\/YYYY/);
  });
});

describe('money parsing — European amounts', () => {
  it('parses an amount exactly as printed on the invoice', () => {
    // Arena Media: TOTAL INVOICE EUR 10.000,00. Previously a 400 — the operator could not
    // type what was in front of them.
    assert.equal(money('10.000,00'), '10000.00');
    // Ready4people: TOTAL 800,00 €
    assert.equal(money('800,00'), '800.00');
    assert.equal(money('400,00'), '400.00');
  });

  it('still parses plain US-style amounts', () => {
    assert.equal(money('10000.00'), '10000.00');
    assert.equal(money('1234.56'), '1234.56');
    assert.equal(money('800'), '800');
  });

  it('uses the last separator as the decimal point when both appear', () => {
    assert.equal(money('1.234,56'), '1234.56');
    assert.equal(money('1,234.56'), '1234.56');
    assert.equal(money('1.234.567,89'), '1234567.89');
  });

  it('treats a repeated separator as grouping', () => {
    assert.equal(money('1.234.567'), '1234567');
    assert.equal(money('1,234,567'), '1234567');
  });

  it('refuses a genuinely ambiguous amount rather than being wrong by 1000x', () => {
    // "1.500" is 1500 to a Spanish supplier and 1.5 to an American one, and nothing in the
    // string resolves it. The old code silently took 1.50 as one-and-a-half.
    assert.throws(() => money('1.500'), /ambiguous/);
    assert.throws(() => money('10,000'), /ambiguous/);
  });

  it('strips currency symbols and stray spaces pasted out of a PDF', () => {
    assert.equal(money('800,00 €'), '800.00');
    assert.equal(money(' € 10.000,00 '), '10000.00');
    assert.equal(money('1 234,56'), '1234.56'); // non-breaking space
  });

  it('keeps a negative amount negative, for credit notes', () => {
    assert.equal(money('-800,00'), '-800.00');
  });

  it('rejects junk', () => {
    assert.throws(() => money('ten thousand'), /must be an amount/);
    assert.throws(() => money(''), /must be an amount/);
    assert.throws(() => money('12,345678'), /decimal places/);
  });
});
