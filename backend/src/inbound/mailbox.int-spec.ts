/**
 * Email inbound, end to end, against a fake mailbox.
 *
 * The IMAP transport itself has never opened a socket — there is no mail server here. But
 * everything downstream of "a message arrived" is production code: attachment filtering,
 * file storage, the ingestion pipeline, deduplication, and the message record. A real
 * `MailboxSource` only has to hand over `MailMessage` objects; this proves what happens next.
 *
 * The PDF bytes used here are the genuine Arena Media invoice supplied by the user, so the
 * storage path handles a real 98 KB document rather than a synthetic buffer.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { closeTestDb, setupTestDb, skipReason, truncateAll, type TestDb } from '../test-support/db';
import { buildServices, type TestServices } from '../test-support/services';
import { seed } from '../db/seed';
import { inboundMessages, invoices } from '../db/schema';
import { MailboxService } from './mailbox.service';
import { FileStorageService } from '../invoices/file-storage.service';
import type { DatabaseService } from '../db/database.service';
import type { MailAttachment, MailMessage, MailboxSource } from './mailbox.types';

const REAL_PDF =
  '/root/.claude/uploads/885a9acd-34f9-5129-b79b-dc833c9c50a8/d8a237ce-arena_media.pdf';

/** Bytes of a real invoice when available, otherwise a small stand-in. */
function pdfBytes(): Buffer {
  return existsSync(REAL_PDF) ? readFileSync(REAL_PDF) : Buffer.from('%PDF-1.4 stand-in');
}

/** In-memory mailbox. Records what was marked so the dedupe contract can be asserted. */
class FakeMailbox implements MailboxSource {
  readonly marked: string[] = [];
  constructor(private messages: MailMessage[]) {}

  async fetchUnread(limit: number) {
    return this.messages.filter((m) => !this.marked.includes(m.messageId)).slice(0, limit);
  }
  async markHandled(messageId: string) {
    this.marked.push(messageId);
  }
  /** Re-delivers everything, as a mailbox does after a crash before the \Seen flag stuck. */
  redeliverAll() {
    this.marked.length = 0;
  }
}

const attach = (filename: string, contentType = 'application/pdf', content = pdfBytes()): MailAttachment => ({
  filename,
  contentType,
  size: content.length,
  content,
});

const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  messageId: `<${Math.random().toString(36).slice(2)}@vendor.com>`,
  from: 'Arena Billing <billing@arenamedia.es>',
  subject: 'Invoice 2026001293',
  receivedAt: new Date('2026-05-04T09:00:00Z'),
  attachments: [attach('invoice.pdf')],
  ...over,
});

describe('email inbound (integration)', { skip: skipReason() }, () => {
  let db: TestDb;
  let svc: TestServices;
  let mailbox: MailboxService;
  let tenantId: string;

  before(async () => {
    db = await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAll(db);
    ({ tenantId } = await seed(db));
    svc = buildServices(db);
    svc.extraction.use('arenamedia');
    mailbox = new MailboxService(
      { db } as unknown as DatabaseService,
      new FileStorageService(),
      svc.invoices,
    );
  });

  after(async () => {
    await closeTestDb();
  });

  const invoiceCount = async () =>
    (await db.select().from(invoices).where(eq(invoices.tenantId, tenantId))).length;

  it('turns an emailed PDF into an invoice in the pipeline', async () => {
    const source = new FakeMailbox([mail()]);

    const result = await mailbox.poll(tenantId, source);

    assert.equal(result.fetched, 1);
    assert.equal(result.invoicesCreated, 1);
    assert.equal(await invoiceCount(), 1);

    const [inv] = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    assert.equal(inv.sourceChannel, 'EMAIL', 'the channel must reflect how it actually arrived');
    assert.equal(inv.status, 'PENDING_APPROVAL', 'it goes down the normal pipeline, not a side path');
    assert.ok(inv.storedFilename, 'the document must be stored, not just parsed');
    assert.ok(inv.fileUrl?.includes('/files/'), 'and reachable by URL, like every other route in');
  });

  it('records the sender and subject for provenance', async () => {
    await mailbox.poll(tenantId, new FakeMailbox([mail()]));

    const [row] = await db.select().from(inboundMessages);
    assert.equal(row.fromAddress, 'billing@arenamedia.es');
    assert.equal(row.subject, 'Invoice 2026001293');
    assert.equal(row.invoicesCreated, 1);
  });

  it('does not re-ingest a message it has already handled', async () => {
    const source = new FakeMailbox([mail({ messageId: '<same@vendor.com>' })]);
    await mailbox.poll(tenantId, source);

    // The mailbox loses its flags — a crash before \Seen stuck, or a server that forgot.
    source.redeliverAll();
    const second = await mailbox.poll(tenantId, source);

    assert.equal(second.alreadyHandled, 1);
    assert.equal(second.invoicesCreated, 0);
    assert.equal(await invoiceCount(), 1, 'a re-delivered message must not become a second invoice');
  });

  it('creates one invoice per attachment when a supplier bills several at once', async () => {
    const source = new FakeMailbox([
      mail({ attachments: [attach('inv-1.pdf'), attach('inv-2.pdf')] }),
    ]);

    const result = await mailbox.poll(tenantId, source);
    assert.equal(result.invoicesCreated, 2);
  });

  it('ignores signature images sitting beside a real invoice', async () => {
    const source = new FakeMailbox([
      mail({
        attachments: [
          attach('invoice.pdf'),
          attach('image001.png', 'image/png', Buffer.alloc(2048, 7)),
          attach('terms.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        ],
      }),
    ]);

    const result = await mailbox.poll(tenantId, source);

    assert.equal(result.invoicesCreated, 1);
    assert.deepEqual(
      result.messages[0].skipped.map((s) => s.reason).sort(),
      ['likely-signature-image', 'unsupported-type'],
    );
  });

  it('records a message with nothing usable instead of ignoring it silently', async () => {
    // A supplier replying "thanks", or an invoice pasted into the body. Not an error, but an
    // operator asking "where is my invoice?" needs to see that it arrived and why nothing
    // came of it.
    const source = new FakeMailbox([mail({ attachments: [] })]);

    const result = await mailbox.poll(tenantId, source);

    assert.equal(result.invoicesCreated, 0);
    const [row] = await db.select().from(inboundMessages);
    assert.equal(row.invoicesCreated, 0);
    assert.deepEqual((row.outcome as { skipped: { reason: string }[] }).skipped[0].reason, 'no-attachments');
  });

  it('marks a message handled so the mailbox does not serve it again', async () => {
    const source = new FakeMailbox([mail({ messageId: '<a@v.com>' }), mail({ messageId: '<b@v.com>' })]);

    await mailbox.poll(tenantId, source);

    assert.deepEqual(source.marked.sort(), ['<a@v.com>', '<b@v.com>']);
    assert.equal((await source.fetchUnread(10)).length, 0);
  });

  it('stores the real PDF byte-for-byte on the way through', async () => {
    if (!existsSync(REAL_PDF)) return; // stand-in bytes; nothing to compare
    const original = readFileSync(REAL_PDF);

    await mailbox.poll(tenantId, new FakeMailbox([mail()]));

    const [inv] = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId));
    const storage = new FileStorageService();
    const chunks: Buffer[] = [];
    for await (const chunk of storage.stream(inv.storedFilename!)) chunks.push(chunk as Buffer);

    assert.ok(Buffer.concat(chunks).equals(original), 'the stored document must be unaltered');
  });
});
