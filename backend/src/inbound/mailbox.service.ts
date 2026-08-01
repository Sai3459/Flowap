import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { inboundMessages } from '../db/schema';
import { FileStorageService } from '../invoices/file-storage.service';
import { InvoicesService } from '../invoices/invoices.service';
import {
  decideAttachments,
  senderAddress,
  type MailMessage,
  type MailboxSource,
} from './mailbox.types';

export interface PollResult {
  fetched: number;
  alreadyHandled: number;
  invoicesCreated: number;
  messages: {
    messageId: string;
    from: string | null;
    subject: string;
    invoiceIds: string[];
    skipped: { filename: string; reason: string }[];
  }[];
}

/**
 * Turns email into invoices.
 *
 * This is the piece that makes "touchless" true at the front door. Until now an invoice
 * entered because a person dragged a PDF into a browser, which meant a human touched every
 * single document at the moment we were claiming not to need one. In real AP the great
 * majority arrive at an `ap@` mailbox.
 *
 * Each accepted attachment is stored through `FileStorageService` and handed to the existing
 * pipeline **by URL** — the same path an upload or a connector push takes. There is no second
 * ingestion route to keep in step.
 *
 * Ordering is deliberate: store and ingest first, record the message second, mark it read
 * last. A crash can therefore produce a duplicate attempt, which the unique key on
 * `(tenantId, messageId)` absorbs — whereas marking read first would lose the invoice
 * entirely. Losing a supplier's invoice is worse than retrying one.
 */
@Injectable()
export class MailboxService {
  private readonly logger = new Logger(MailboxService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly fileStorage: FileStorageService,
    private readonly invoices: InvoicesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async poll(tenantId: string, source: MailboxSource, limit = 25): Promise<PollResult> {
    const messages = await source.fetchUnread(limit);
    const result: PollResult = {
      fetched: messages.length,
      alreadyHandled: 0,
      invoicesCreated: 0,
      messages: [],
    };

    for (const message of messages) {
      if (await this.alreadyHandled(tenantId, message.messageId)) {
        result.alreadyHandled += 1;
        // Still mark it: the row proves it was dealt with, the flag stops it being refetched.
        await source.markHandled(message.messageId);
        continue;
      }

      const handled = await this.handleMessage(tenantId, message);
      result.invoicesCreated += handled.invoiceIds.length;
      result.messages.push(handled);
      await source.markHandled(message.messageId);
    }

    return result;
  }

  private async alreadyHandled(tenantId: string, messageId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: inboundMessages.id })
      .from(inboundMessages)
      .where(
        and(eq(inboundMessages.tenantId, tenantId), eq(inboundMessages.messageId, messageId)),
      );
    return Boolean(row);
  }

  private async handleMessage(tenantId: string, message: MailMessage) {
    const decisions = decideAttachments(message);
    const from = senderAddress(message.from);
    const invoiceIds: string[] = [];
    const skipped: { filename: string; reason: string }[] = [];

    for (const decision of decisions) {
      if (!decision.accepted) {
        skipped.push({ filename: decision.attachment.filename, reason: decision.reason! });
        continue;
      }

      try {
        // Same shape multer hands the upload endpoint, so both routes store identically.
        const stored = await this.fileStorage.save({
          originalname: decision.attachment.filename,
          mimetype: decision.attachment.contentType,
          buffer: decision.attachment.content,
        });
        const invoice = await this.invoices.ingest(
          tenantId,
          { fileUrl: stored.url, sourceChannel: 'EMAIL' },
          stored,
        );
        invoiceIds.push(invoice.id);
      } catch (err) {
        // One bad attachment must not abandon the rest of the message, or a signature image
        // that slipped through the filter would block a real invoice sitting beside it.
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(`Attachment ${decision.attachment.filename} failed: ${reason}`);
        skipped.push({ filename: decision.attachment.filename, reason: `failed: ${reason}` });
      }
    }

    if (decisions.length === 0) {
      // Common and not an error: a supplier replying "thanks", or an invoice pasted into the
      // body with nothing attached. Recorded so it is visible rather than mysterious.
      skipped.push({ filename: '(none)', reason: 'no-attachments' });
    }

    await this.db
      .insert(inboundMessages)
      .values({
        tenantId,
        messageId: message.messageId,
        fromAddress: from,
        subject: message.subject,
        receivedAt: message.receivedAt,
        invoicesCreated: invoiceIds.length,
        outcome: { accepted: invoiceIds.length, skipped },
      })
      // Absorbs the retry a crash between ingest and record would cause.
      .onConflictDoNothing({
        target: [inboundMessages.tenantId, inboundMessages.messageId],
      });

    this.logger.log(
      `Message ${message.messageId} from ${from ?? 'unknown'}: ` +
        `${invoiceIds.length} invoice(s), ${skipped.length} skipped`,
    );

    return { messageId: message.messageId, from, subject: message.subject, invoiceIds, skipped };
  }

  /** Recent inbound history, so an operator can see what arrived and what was ignored. */
  async recent(tenantId: string, limit = 50) {
    return this.db
      .select()
      .from(inboundMessages)
      .where(eq(inboundMessages.tenantId, tenantId))
      .limit(limit);
  }
}
