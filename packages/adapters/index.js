/**
 * Adapter registry.
 *
 * Adding a provider: write a sibling of claude.js / chatgpt.js exposing the
 * same shape, then add it to ADAPTERS below. Nothing else changes — not the
 * probe, not the exporter, not the app.
 *
 * @typedef {Object} Adapter
 * @property {string}   id          'claude' | 'chatgpt' | …
 * @property {string}   label       human name
 * @property {string[]} hosts       hostnames this adapter claims
 * @property {string}   accent      colour for console output
 * @property {() => Promise<object>}                 init       auth / discovery
 * @property {() => Promise<ListItem[]>}             list       {id,title,updatedAt,_raw}
 * @property {(id: string) => Promise<any>}          detail     raw payload
 * @property {() => string|null}                     currentId  from the URL
 * @property {(raw: any, item?: ListItem) => Promise<object>} convert  -> .chat
 * @property {(result: object) => Promise<object>}   probe      diagnostics
 */

import { claude } from './claude.js';
import { chatgpt } from './chatgpt.js';

export const ADAPTERS = [claude, chatgpt];

/** @returns {Adapter|null} */
export function adapterForHost(hostname) {
  return ADAPTERS.find((a) => a.hosts.includes(hostname)) || null;
}

export const SUPPORTED_HOSTS = ADAPTERS.flatMap((a) => a.hosts);
