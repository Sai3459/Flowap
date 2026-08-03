import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TTL_SECONDS, signedPath, signingKey } from './signed-url';

/**
 * Local disk storage for uploaded invoice documents.
 *
 * The point of storing them and serving them back over HTTP is that the extraction service
 * fetches documents *by URL* — so an uploaded file takes exactly the same path through the
 * pipeline as one posted in by a connector, with no special case. Swap this for S3 or blob
 * storage in production; the URL contract is what the rest of the system depends on.
 */
@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly root = process.env.UPLOAD_DIR || join(process.cwd(), 'uploads');
  /** How the extraction service should address this API to fetch a stored file. */
  private readonly publicBase =
    process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`;

  constructor() {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
      this.logger.log(`Created upload directory ${this.root}`);
    }
  }

  async save(file: { originalname: string; mimetype: string; buffer: Buffer }) {
    // Never trust the client's filename on disk — generate our own and keep theirs as metadata.
    const storedFilename = `${randomUUID()}${extname(file.originalname).slice(0, 10)}`;
    await writeFile(join(this.root, storedFilename), file.buffer);

    return {
      storedFilename,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.buffer.length,
      url: this.signedUrl(storedFilename),
    };
  }

  /**
   * A signed, expiring URL for a stored document.
   *
   * The extraction service fetches this as an anonymous client, so the link itself has to carry
   * the authorisation. Previously the URL was just the filename — an unguessable UUID, which is
   * not a credential: it never expired, and anyone who saw it in a log or a proxy kept access
   * forever.
   */
  signedUrl(storedFilename: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
    return `${this.publicBase}${signedPath(storedFilename, signingKey(), ttlSeconds)}`;
  }

  /** Streams a stored file back. Rejects anything that isn't a plain filename we generated. */
  /**
   * Media type for a stored file, from its extension — the stored name is the only thing left
   * once the upload request is gone. Limited to what the upload endpoint accepts, so an
   * unexpected extension falls back to a type no client will try to render.
   */
  mimeTypeFor(storedFilename: string): string {
    const byExtension: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    return byExtension[extname(storedFilename).toLowerCase()] ?? 'application/octet-stream';
  }

  stream(storedFilename: string) {
    const safe = basename(storedFilename);
    const path = join(this.root, safe);
    if (safe !== storedFilename || !existsSync(path)) {
      throw new NotFoundException('File not found');
    }
    return createReadStream(path);
  }
}
