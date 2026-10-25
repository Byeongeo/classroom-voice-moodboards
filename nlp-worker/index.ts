import { Container, getContainer } from '@cloudflare/containers';

export class KoreanNlp extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = false;
}
export default {
  async fetch(request: Request, env: { KOREAN_NLP: DurableObjectNamespace<KoreanNlp> }) {
    const url = new URL(request.url);
    if (url.pathname !== '/analyze' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    return getContainer(env.KOREAN_NLP, 'korean-analysis').fetch(request);
  },
};
