/**
 * A `LIKE` pattern that finds `text` anywhere, with the text's own `%`, `_` and `\` matched
 * literally (security review, finding 16). Unescaped, a search for `_` matched every row and a
 * search for `%` returned the whole table — harmless in what it shows, since every list is
 * scoped, but a full scan on demand for anyone who can type in a search box.
 *
 * The backslash is PostgreSQL's default `LIKE` escape character, so the queries need no
 * `ESCAPE` clause.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function containing(text: string): string {
  return `%${escapeLike(text)}%`;
}
