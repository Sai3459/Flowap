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
    const stream = this.fileStorage.stream(storedFilename);
    stream.pipe(res);
  }
}
