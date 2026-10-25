/**
 * The C0 control characters imported text refuses (tab, line feed and
 * carriage return are allowed): the one definition (#8313; F2). It is
 * importedTicket.ts's text rule, which builds its schema from it, and
 * importText.ts strips exactly these (`stripRefusedControlChars`) for the
 * modules. A leaf: it imports nothing, so the pure helpers can share it.
 */
export const REFUSED_CONTROL_CHAR_CLASS = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F';
