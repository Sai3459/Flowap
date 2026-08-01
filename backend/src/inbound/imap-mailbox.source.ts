import { Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { MailMessage, MailboxSource } from './mailbox.types';

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
}

/**
 * IMAP transport for the inbound poller.
 *
 * ⚠️ **Never executed.** There is no mail server in this sandbox, so this class has been
 * typechecked and reviewed but never opened a socket. Everything that makes a *decision* —
 * which attachments become invoices, deduplication, failure handling — lives behind
 * `MailboxSource` in `mailbox.types.ts` and `mailbox.service.ts`, and is fully tested against
 * a fake. This file is the part still to be proven against a real mailbox.
 *
 * Configuration is per-process for now (`INBOUND_IMAP_*`). It belongs in per-tenant config
 * once the config plane exists — a real deployment has one mailbox per tenant, and the
 * password must come from a secret store rather than an environment variable.
 */
export class ImapMailboxSource implements MailboxSource {
  private readonly logger = new Logger(ImapMailboxSource.name);

  constructor(private readonly config: ImapConfig) {}

  /** Reads config from the environment, or null when inbound mail is not configured. */
  static fromEnv(): ImapMailboxSource | null {
    const { INBOUND_IMAP_HOST, INBOUND_IMAP_USER, INBOUND_IMAP_PASSWORD } = process.env;
    if (!INBOUND_IMAP_HOST || !INBOUND_IMAP_USER || !INBOUND_IMAP_PASSWORD) return null;

    return new ImapMailboxSource({
      host: INBOUND_IMAP_HOST,
      port: Number(process.env.INBOUND_IMAP_PORT ?? 993),
      secure: process.env.INBOUND_IMAP_SECURE !== 'false',
      user: INBOUND_IMAP_USER,
      password: INBOUND_IMAP_PASSWORD,
      mailbox: process.env.INBOUND_IMAP_MAILBOX ?? 'INBOX',
    });
  }

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
    await client.connect();
    return client;
  }

  async fetchUnread(limit: number): Promise<MailMessage[]> {
    const client = await this.connect();
    const messages: MailMessage[] = [];

    try {
      const lock = await client.getMailboxLock(this.config.mailbox);
      try {
        // Deliberately does NOT set \Seen here. The message is only marked once its
        // attachments are safely stored — see markHandled — so a crash mid-processing
        // re-delivers rather than silently losing a supplier's invoice.
        for await (const msg of client.fetch({ seen: false }, { source: true, envelope: true })) {
          if (messages.length >= limit) break;
          if (!msg.source) continue; // nothing to parse

          // The overloaded callback signature resolves to `void` here; the promise form is
          // the one in use, so it is narrowed explicitly rather than left as `any`.
          const parsed = (await simpleParser(msg.source)) as unknown as ParsedMail;
          const messageId = parsed.messageId ?? msg.envelope?.messageId;
          if (!messageId) {
            // Without a Message-ID there is no dedupe key, and re-ingesting a supplier's
            // invoice is a duplicate-payment risk. Refuse rather than guess.
            this.logger.warn(`Skipping message with no Message-ID (uid ${msg.uid})`);
            continue;
          }

          messages.push({
            messageId,
            from: parsed.from?.text ?? '',
            subject: parsed.subject ?? '',
            receivedAt: parsed.date ?? new Date(),
            attachments: (parsed.attachments ?? []).map((a) => ({
              filename: a.filename ?? 'attachment',
              contentType: a.contentType,
              size: a.size,
              content: a.content as Buffer,
            })),
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    // Oldest first, so a supplier's invoices are ingested in the order they were sent.
    return messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async markHandled(messageId: string): Promise<void> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(this.config.mailbox);
      try {
        await client.messageFlagsAdd({ header: { 'message-id': messageId } }, ['\\Seen']);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
