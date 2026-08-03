import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as reachable without authentication.
 *
 * Deliberately an opt-*out*: the global guard closes everything, so this is the only way to
 * open a route and it has to be written on purpose. Keep the list short and justify each one
 * at the call site — every `@Public()` is an endpoint an anonymous caller can reach.
 */
export const IS_PUBLIC = 'flowap:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
