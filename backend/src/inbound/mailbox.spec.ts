import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decideAttachments, senderAddress, type MailMessage } from './mailbox.types';

const attachment = (over: Partial<{ filename: string; contentType: string; size: number }> = {}) => {
  const size = over.size ?? 1024;
  return {
    filename: over.filename ?? 'invoice.pdf',
    contentType: over.contentType ?? 'application/pdf',
    size,
    content: Buffer.alloc(Math.min(size, 4096), 1),
  };
};

const message = (attachments: ReturnType<typeof attachment>[]): MailMessage => ({
  messageId: '<test@example.com>',
  from: 'Billing <billing@vendor.com>',
  subject: 'Invoice',
  receivedAt: new Date('2026-05-04T09:00:00Z'),
  attachments,
});

describe('decideAttachments — what becomes an invoice', () => {
  it('accepts a PDF', () => {
    const [d] = decideAttachments(message([attachment()]));
    assert.equal(d.accepted, true);
  });

  it('accepts scans as images', () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp']) {
      const [d] = decideAttachments(message([attachment({ contentType, filename: 'scan.png' })]));
      assert.equal(d.accepted, true, contentType);
    }
  });

  it('rejects the office documents suppliers attach alongside', () => {
    for (const contentType of ['application/msword', 'text/calendar', 'application/zip']) {
      const [d] = decideAttachments(message([attachment({ contentType })]));
      assert.equal(d.accepted, false, contentType);
      assert.equal(d.reason, 'unsupported-type');
    }
  });

  it('rejects Outlook signature images by filename, not by size', () => {
    // Every mail from a corporate sender carries these. Each one that gets through costs an
    // extraction call and puts a junk row in the review queue.
    for (const filename of ['image001.png', 'logo.png', 'signature.jpg', 'att0001.png']) {
      const [d] = decideAttachments(message([attachment({ filename, contentType: 'image/png' })]));
      assert.equal(d.accepted, false, filename);
      assert.equal(d.reason, 'likely-signature-image');
    }
  });

  it('keeps a genuinely small scan that is not named like a signature', () => {
    // Judging on size alone would drop this. A 3 KB PNG called invoice-scan.png might be a
    // real, badly-compressed document.
    const [d] = decideAttachments(
      message([attachment({ filename: 'invoice-scan.png', contentType: 'image/png', size: 3000 })]),
    );
    assert.equal(d.accepted, true);
  });

  it('rejects an oversized attachment', () => {
    const [d] = decideAttachments(message([attachment({ size: 21 * 1024 * 1024 })]));
    assert.equal(d.reason, 'too-large');
  });

  it('rejects an empty attachment', () => {
    const [d] = decideAttachments(message([attachment({ size: 0 })]));
    assert.equal(d.reason, 'empty');
  });

  it('takes every invoice when a supplier sends several in one mail', () => {
    // Common with monthly billing runs. Taking only the first would silently lose the rest.
    const decisions = decideAttachments(
      message([
        attachment({ filename: 'inv-1.pdf' }),
        attachment({ filename: 'inv-2.pdf' }),
        attachment({ filename: 'image001.png', contentType: 'image/png' }),
      ]),
    );
    assert.equal(decisions.filter((d) => d.accepted).length, 2);
    assert.equal(decisions.filter((d) => !d.accepted).length, 1);
  });

  it('returns nothing for a message with no attachments', () => {
    assert.deepEqual(decideAttachments(message([])), []);
  });
});

describe('senderAddress', () => {
  it('pulls the address out of a display-name header', () => {
    assert.equal(senderAddress('Billing <billing@vendor.com>'), 'billing@vendor.com');
    assert.equal(senderAddress('billing@vendor.com'), 'billing@vendor.com');
  });

  it('lower-cases, so one supplier is one address', () => {
    assert.equal(senderAddress('Billing <BILLING@Vendor.COM>'), 'billing@vendor.com');
  });

  it('returns null rather than junk when there is no usable address', () => {
    assert.equal(senderAddress(''), null);
    assert.equal(senderAddress('undisclosed-recipients'), null);
  });
});
