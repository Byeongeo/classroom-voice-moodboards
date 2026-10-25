// Local-only adapter; production uses the private Cloudflare Container service.
export default {
  fetch(request: Request, env: { LOCAL_NLP_URL: string }) {
    return fetch(new Request(`${env.LOCAL_NLP_URL}${new URL(request.url).pathname}`, request));
  },
};
