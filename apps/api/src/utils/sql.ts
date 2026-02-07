/**
 * SQL utility functions shared across services.
 */

/**
 * Escape special characters in a LIKE pattern to prevent wildcard injection.
 * Escapes %, _, and \ characters.
 */
export function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, '\\$&');
}
