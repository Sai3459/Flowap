/**
 * The mailbox contract, and the pure rules for turning a message into invoices.
 *
 * Why this shape: the transport (IMAP) cannot be exercised here — there is no mail server in
 * this sandbox — so everything that *decides* anything lives behind an interface and is
 * tested against a fake. The same discipline as the extraction stub: the logic is proven, the
 * socket is not.
 */

export interface MailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface MailMessage {
  /** RFC 5322 Message-ID. The dedupe key — a re-poll must not re-ingest. */
  messageId: string;
  from: string;
  subject: string;
  receivedAt: Date;
  attachments: MailAttachment[];
}

/** Where messages come from. `ImapMailboxSource` is the real one; tests use a fake. */
export interface MailboxSource {
  /** Unread messages, oldest first. Implementations must not mark them read until told. */
  fetchUnread(limit: number): Promise<MailMessage[]>;
  /** Called once a message's attachments are safely stored, so it is not fetched again. */
  markHandled(messageId: string): Promise<void>;
}

/** What the poller accepts. Anything else is skipped with a reason, never silently dropped. */
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

/** 20 MB, matching the upload endpoint — one limit, not two that can drift apart. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Filenames that are almost never the invoice. Suppliers and mail clients attach these to
 * practically every message, and each one that gets through costs an extraction call and
 * lands a junk row in the review queue.
 */
const NOISE_FILENAME_PATTERNS = [
  /^image\d{3,}\./i,        // image001.png — Outlook's inline signature images
  /^logo/i,
  /^signature/i,
  /^smime\.p7s$/i,
  /^winmail\.dat$/i,
  /^att\d+\./i,
];

export type SkipReason =
  | 'unsupported-type'
  | 'too-large'
  | 'empty'
  | 'likely-signature-image'
  | 'no-attachments';

export interface AttachmentDecision {
  attachment: MailAttachment;
  accepted: boolean;
  reason?: SkipReason;
}

/**
 * Decides which of a message's attachments should become invoices.
 *
 * Deliberately permissive about *content* and strict about *shape*: this cannot tell an
 * invoice from a delivery note, and should not try — that is the extractor's job, and
 * `documentType` already comes back from it. What it can do is refuse things that are
 * definitely not documents, so they never cost an extraction call.
 *
 * Small images are the interesting case. A 4 KB PNG called `image001.png` is a signature
 * logo in every real mailbox; a 4 KB PNG called `invoice-scan.png` might be real. Judging on
 * the filename pattern rather than size alone keeps a genuinely tiny scan from being dropped.
 */
export function decideAttachments(message: MailMessage): AttachmentDecision[] {
  return message.attachments.map((attachment) => {
    if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(attachment.contentType)) {
      return { attachment, accepted: false, reason: 'unsupported-type' as const };
    }
    if (attachment.size <= 0 || attachment.content.length === 0) {
      return { attachment, accepted: false, reason: 'empty' as const };
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      return { attachment, accepted: false, reason: 'too-large' as const };
    }
    if (
      attachment.contentType.startsWith('image/') &&
      NOISE_FILENAME_PATTERNS.some((p) => p.test(attachment.filename))
    ) {
      return { attachment, accepted: false, reason: 'likely-signature-image' as const };
    }
    return { attachment, accepted: true };
  });
}

/**
 * The sender address, lower-cased, or null. Stored on the invoice as a provenance breadcrumb
 * and a future vendor hint — a supplier mailing from `billing@vendor.com` every month is a
 * strong corroborating signal once fraud checks exist. Not used for matching today, because
 * a forwarded invoice arrives from an internal address and would match the wrong vendor.
 */
export function senderAddress(from: string): string | null {
  const angle = /<([^>]+)>/.exec(from);
  const raw = (angle ? angle[1] : from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}
