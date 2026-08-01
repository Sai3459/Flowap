import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { FileStorageService } from './file-storage.service';

/**
 * Serves stored documents back over HTTP.
 *
 * Deliberately not tenant-scoped by a header: the extraction service fetches these URLs as an
 * anonymous client, and filenames are unguessable UUIDs. That is fine for a prototype and
 * **not** fine for production — real deployments want signed, expiring URLs, because an
 * invoice PDF is confidential.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly fileStorage: FileStorageService) {}

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
