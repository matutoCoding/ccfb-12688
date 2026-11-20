/** 极简 hash 路由 */
import { disposePreview } from './preview-page';

export type RouteHandler = (params: Record<string, string>) => void;

const routes = new Map<string, RouteHandler>();
let notFound: RouteHandler | null = null;
let lastPath = '';

export function registerRoute(path: string, handler: RouteHandler): void {
  routes.set(path, handler);
}

export function registerNotFound(handler: RouteHandler): void {
  notFound = handler;
}

export function navigate(path: string): void {
  if (location.hash === `#${path}`) {
    dispatch();
  } else {
    location.hash = path;
  }
}

function dispatch(): void {
  const raw = location.hash.replace(/^#/, '') || '/library';
  const [path, query] = raw.split('?');
  if (lastPath && lastPath !== path && lastPath === '/preview') {
    disposePreview();
  }
  lastPath = path;
  const params: Record<string, string> = {};
  if (query) {
    for (const pair of query.split('&')) {
      const [k, v = ''] = pair.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  const handler = routes.get(path) ?? notFound;
  handler?.(params);
}

export function startRouter(): void {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash) location.hash = '/library';
  dispatch();
}

export function currentPath(): string {
  return location.hash.replace(/^#/, '').split('?')[0] || '/library';
}
