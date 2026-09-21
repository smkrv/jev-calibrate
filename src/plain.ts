/**
 * Example ids, option names, API error bodies and model names reach the terminal from files
 * and servers the user does not control. Control characters in them could redraw a line and
 * forge a verdict, so everything printed for a person goes through here. JSON output is
 * left alone: JSON.stringify escapes these characters by itself.
 */
export function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
}
