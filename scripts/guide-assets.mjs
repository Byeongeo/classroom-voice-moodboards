import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The downloadable guide is standalone. Trust its exact inline script without
// allowing arbitrary inline scripts in the classroom app.
export function guideHeaders(html, headers) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1 || !headers.includes("script-src 'self';"))
    throw new Error('연수 안내의 스크립트와 보안 정책을 확인해 주세요.');
  // HTML parsing normalizes CRLF and CR before CSP checks the script text.
  const source = scripts[0][1].replace(/\r\n?/g, '\n');
  const hash = createHash('sha256').update(source).digest('base64');
  return headers.replace("script-src 'self';", `script-src 'self' 'sha256-${hash}';`);
}

export function writeGuideHeaders(directory) {
  const file = path.join(directory, '_headers');
  writeFileSync(file, guideHeaders(readFileSync(path.join(directory, 'training-guide.html'), 'utf8'), readFileSync(file, 'utf8')));
}
