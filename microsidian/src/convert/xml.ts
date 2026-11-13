import { DOMParser } from "@xmldom/xmldom";

// xmldom's nodes are DOM-compatible; keep our own loose alias so strict typing doesn't get in the way.
export type El = Element;

export function parseXml(xml: string): Document {
  // Some generators put a byte-order mark or whitespace before the XML declaration.
  const clean = xml.replace(/^[﻿\s]+/, "");
  return new DOMParser({ onError: () => undefined }).parseFromString(clean, "text/xml") as unknown as Document;
}

/** Direct element children, optionally filtered by qualified name (e.g. "w:p"). */
export function kids(el: Node | null | undefined, name?: string): El[] {
  const out: El[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as El).nodeName === name)) out.push(n as El);
  }
  return out;
}

export function kid(el: Node | null | undefined, name: string): El | null {
  return kids(el, name)[0] ?? null;
}

/** All descendant elements with the given qualified name, in document order. */
export function desc(el: El | Document, name: string): El[] {
  const list = el.getElementsByTagName(name);
  const out: El[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i] as El);
  return out;
}

export function attr(el: El | null | undefined, name: string): string | null {
  if (!el) return null;
  const v = el.getAttribute(name);
  return v === "" || v === null ? null : v;
}

/** True for OOXML boolean toggles: present and not "0"/"false"/"none". */
export function on(el: El | null | undefined, valAttr: string): boolean {
  if (!el) return false;
  const v = el.getAttribute(valAttr);
  return v === null || v === "" || !["0", "false", "none"].includes(v);
}

export function textOf(el: El): string {
  return el.textContent ?? "";
}

/** Is `el` inside an element with the given name (stopping at `root`)? */
export function insideOf(el: El, name: string, root: El): boolean {
  for (let p = el.parentNode as El | null; p && p !== root; p = p.parentNode as El | null) {
    if (p.nodeName === name) return true;
  }
  return false;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (base ? base.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const s of parts) {
    if (s === "..") out.pop();
    else if (s && s !== ".") out.push(s);
  }
  return out.join("/");
}
