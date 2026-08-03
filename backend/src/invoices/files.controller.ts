import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { FileStorageService } from './file-storage.service';
import { Public } from '../auth/public.decorator';

/**
 * Serves stored documents back over HTTP.
 *
 * **This is the one authenticated-API route that is deliberately `@Public()`**, and it is the
 * weakest point in the system now that everything else requires a token. The extraction
 * service fetches these URLs as an anonymous HTTP client — it is a separate Python process
 * with no Flowap session — so requiring a bearer token here would break ingestion.
 *
 * What protects a document today is only that its filename is an unguessable UUID. That is
 * adequate for a prototype and **not** adequate for production: an invoice PDF is
 * confidential, and a URL that never expires and needs no credential will end up in a log, a
 * proxy, or a browser history.
 *
 * The fix is not to put a token on this route — it is to stop passing raw URLs at all:
 * **signed, expiring URLs** (or handing the extractor bytes over an authenticated internal
 * channel). Tracked as a known gap; see CLAUDE.md.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly fileStorage: FileStorageService) {}

  @Public()
  @Get(':storedFilename')
  serve(@Param('storedFilename') storedFilename: string, @Res() res: Response) {
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
