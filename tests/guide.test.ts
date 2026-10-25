import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';
import { guideHeaders } from '../scripts/guide-assets.mjs';

it('단일 HTML의 실제 스크립트만 CSP에서 허용하고 줄바꿈 차이에도 일치한다', () => {
  const html = readFileSync('public/training-guide.html', 'utf8');
  const headers = readFileSync('public/_headers', 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)![1].replace(/\r\n?/g, '\n');
  expect(() => new Script(source)).not.toThrow();
  const policy = guideHeaders(html, headers);
  expect(policy).toContain(`script-src 'self' 'sha256-${createHash('sha256').update(source).digest('base64')}';`);
  expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(guideHeaders(html.replace(/\r?\n/g, '\r\n'), headers)).toBe(policy);
  expect(guideHeaders(html.replace('updateProgress();\n})();', 'updateProgress();\n/* changed */\n})();'), headers)).not.toBe(policy);
});
