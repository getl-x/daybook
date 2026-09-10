/**
 * 托管前端产物（web/dist）。
 *
 * - 有产物：静态文件 + SPA 回退（任何非 /v1、非 /healthz 的 GET 都返回 index.html）；
 * - 没有产物：直接不注册，只提供 API——本地用 `npm run dev -w @daybook/web`（Vite 代理 /v1）时就是这样。
 *
 * 因此镜像自包含：一个容器同时提供页面与 API，反代只需指向 8090（见计划 §7.1）。
 */
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

const ONE_HOUR_MS = 60 * 60 * 1000;

/** 看起来像静态资源（带常见扩展名）的路径 */
const ASSET_PATTERN =
  /\.(?:js|mjs|cjs|css|map|json|webmanifest|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|txt|xml|wasm)$/i;

export async function registerWebApp(app: FastifyInstance, webDistDir: string): Promise<boolean> {
  if (!existsSync(join(webDistDir, 'index.html'))) return false;

  await app.register(fastifyStatic, {
    root: webDistDir,
    index: ['index.html'],
    cacheControl: true,
    maxAge: ONE_HOUR_MS,
    setHeaders(response, path) {
      // 注意：@fastify/static v8 传进来的是 Fastify Reply（用 .header），
      // 早期版本传原生 ServerResponse（用 .setHeader）——两种都兼容，写错会直接崩进程。
      const target = response as unknown as {
        header?: (name: string, value: string) => unknown;
        setHeader?: (name: string, value: string) => unknown;
      };
      const setHeader = (name: string, value: string): void => {
        if (typeof target.header === 'function') {
          target.header(name, value);
          return;
        }
        if (typeof target.setHeader === 'function') {
          target.setHeader(name, value);
        }
      };

      // 文件名带内容哈希的构建产物可以长期缓存
      if (path.includes(`${join('assets')}`)) {
        setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
      // Service Worker 不能被长缓存，否则更新发不出去
      if (path.endsWith('sw.js')) {
        setHeader('cache-control', 'no-cache');
      }
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const url = (request.url.split('?')[0] ?? '/').replace(/\\/g, '/');
    const isApi = url.startsWith('/v1/') || url === '/healthz';
    // 静态资源找不到就该 404。早期版本一律回 index.html：发版后旧页面引用到已被清掉的
    // /assets/xxx.js 时会拿到 200 的 HTML，浏览器报 MIME 错误 → 白屏，且极难排查。
    const looksLikeAsset = url.startsWith('/assets/') || ASSET_PATTERN.test(url);

    if (!isApi && !looksLikeAsset && request.method === 'GET') return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });

  return true;
}
