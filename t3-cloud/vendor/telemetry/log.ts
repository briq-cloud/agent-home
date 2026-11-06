/**
 * One JSON line per event on stderr. Never a message's content, a prompt, a token or a URL with
 * a code in it: names, ids and counts only.
 */
function line(level: string, message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => line('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => line('warn', message, fields),
};
