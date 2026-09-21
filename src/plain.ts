/**
 * Example ids, option names, API error bodies and model names reach the terminal from files
 * and servers the user does not control. Control characters in them could redraw a line, and
 * a line break could add whole lines, enough to forge a verdict block. Everything printed
 * for a person goes through here, one output line at a time: the renderers join the lines
 * afterwards, so no legitimate line contains a break. JSON output is left alone:
 * JSON.stringify escapes these characters by itself.
 */
export function plain(line: string): string {
  return line.replace(/\r?\n/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}
