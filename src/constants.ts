/**
 * Shared constants used across explore, synthesize, and pipeline modules.
 */

import { DEFAULT_DAEMON_PORT as WTS_DEFAULT_DAEMON_PORT } from './runtime-identity.js';

/** Default daemon port for HTTP/WebSocket communication with browser extension */
export const DEFAULT_DAEMON_PORT = WTS_DEFAULT_DAEMON_PORT;

export function unsupportedDaemonPortEnvMessage(value?: string): string {
  const suffix = value ? ` (received ${value})` : '';
  return `WTSCLI_DAEMON_PORT is fixed and cannot be overridden${suffix}. ` +
    `The WTSCLI Chrome extension can only connect to 127.0.0.1:${DEFAULT_DAEMON_PORT}. ` +
    'Unset WTSCLI_DAEMON_PORT and rerun wtscli.';
}

/**
 * True when WTSCLI_DAEMON_PORT carries no real configuration: unset, empty,
 * or equal to the default port. Launchers (notably OpenCLIApp) inject the
 * variable with the default value into every CLI they manage — rejecting that
 * harmless redundancy bricked all commands on fresh installs (#2068). Only a
 * NON-default value is a genuine misconfiguration worth failing on.
 */
export function isIgnorableDaemonPortEnv(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return Number(trimmed) === DEFAULT_DAEMON_PORT;
}

/** URL query params that are volatile/ephemeral and should be stripped from patterns */
export const VOLATILE_PARAMS = new Set([
  'w_rid', 'wts', '_', 'callback', 'timestamp', 't', 'nonce', 'sign',
]);

/** Search-related query parameter names */
export const SEARCH_PARAMS = new Set([
  'q', 'query', 'keyword', 'search', 'wd', 'kw', 'search_query', 'w',
]);

/** Pagination-related query parameter names */
export const PAGINATION_PARAMS = new Set([
  'page', 'pn', 'offset', 'cursor', 'next', 'page_num',
]);

/** Limit/page-size query parameter names */
export const LIMIT_PARAMS = new Set([
  'limit', 'count', 'size', 'per_page', 'page_size', 'ps', 'num',
]);

/** Field role → common API field names mapping */
export const FIELD_ROLES: Record<string, string[]> = {
  title:    ['title', 'name', 'text', 'content', 'desc', 'description', 'headline', 'subject'],
  url:      ['url', 'uri', 'link', 'href', 'permalink', 'jump_url', 'web_url', 'share_url'],
  author:   ['author', 'username', 'user_name', 'nickname', 'nick', 'owner', 'creator', 'up_name', 'uname'],
  score:    ['score', 'hot', 'heat', 'likes', 'like_count', 'view_count', 'views', 'play', 'favorite_count', 'reply_count'],
  time:     ['time', 'created_at', 'publish_time', 'pub_time', 'date', 'ctime', 'mtime', 'pubdate', 'created'],
  id:       ['id', 'aid', 'bvid', 'mid', 'uid', 'oid', 'note_id', 'item_id'],
  cover:    ['cover', 'pic', 'image', 'thumbnail', 'poster', 'avatar'],
  category: ['category', 'tag', 'type', 'tname', 'channel', 'section'],
};
