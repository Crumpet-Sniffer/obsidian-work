import { requestUrl } from "obsidian";

/**
 * fetch() implemented with Obsidian's requestUrl, which is not subject to browser CORS rules.
 * Used as the Anthropic SDK's `fetch` so API calls work from inside Obsidian.
 */
export const obsidianFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    if (!["content-length", "host", "connection"].includes(k.toLowerCase())) headers[k] = v;
  });
  let body: string | ArrayBuffer | undefined;
  if (typeof init?.body === "string") body = init.body;
  else if (init?.body instanceof ArrayBuffer) body = init.body;
  else if (init?.body instanceof Uint8Array) body = init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength) as ArrayBuffer;

  const res = await requestUrl({
    url,
    method: init?.method ?? "GET",
    headers,
    body,
    contentType: headers["content-type"],
    throw: false,
  });
  const noBody = [101, 204, 205, 304].includes(res.status);
  return new Response(noBody ? null : res.arrayBuffer, { status: res.status, headers: res.headers });
};
