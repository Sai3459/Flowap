import { Controller, Get, Logger, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { FileStorageService } from './file-storage.service';
import { Public } from '../auth/public.decorator';
import { signingKey, verify } from './signed-url';

/**
 * Serves stored documents back over HTTP.
 *
 * **This is the one authenticated-API route that is deliberately `@Public()`**, and it is the
 * weakest point in the system now that everything else requires a token. The extraction
 * service fetches these URLs as an anonymous HTTP client — it is a separate Python process
 * with no Flowap session — so requiring a bearer token here would break ingestion.
 *
 * So the link itself carries the authorisation: every URL is **signed and expiring**
 * (`signed-url.ts`). That closes what an unguessable UUID could not — the signature is bound
 * to one filename, so it cannot be replayed against another document; it expires, so a link
 * leaked into a log or a proxy stops working; and it cannot be minted without the key.
 *
 * Still not perfect, and worth knowing: within its TTL the link is a bearer credential for
 * that one document. Shortening the TTL narrows that window; handing the extractor bytes over
 * an authenticated internal channel would remove it entirely.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(private readonly fileStorage: FileStorageService) {}

  @Public()
  @Get(':storedFilename')
  serve(
    @Param('storedFilename') storedFilename: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() res: Response,
  ) {
    // `@Public()` means unauthenticated, not unauthorised. The signature is the credential:
    // it binds this link to this filename, expires, and cannot be minted without the key.
    const result = verify(storedFilename, exp, sig, signingKey());
    if (!result.ok) {
      this.logger.warn(`Refused ${storedFilename}: signature ${result.reason}`);
      // 404 rather than 403 on purpose. A distinct 403 would confirm the document exists,
      // which is exactly what an unauthenticated caller must not be able to probe for.
      throw new NotFoundException('Not found');
    }

    // Content-Type matters here: this endpoint exists so the extraction service can fetch the
    // document, and a vision call has to declare the media type of what it is sending. Served
    // without it, a real PDF came back as `content-type: null` — the extractor would have had
    // to guess from the extension. Derived from the stored name because that is the only
    // authority once the upload request is gone.
    res.type(this.fileStorage.mimeTypeFor(storedFilename));
    // Unguessable UUID or not, an invoice is confidential — keep it out of shared caches.
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = this.fileStorage.stream(storedFilename);
    stream.pipe(res);
  }
}
