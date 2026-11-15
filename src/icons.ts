import { readFileSync } from "node:fs";
import type { Request, Response } from "express";

// The service's own icon, as real files at the root of the site. Browsers, favicon services and AI
// apps look for an icon there; when they find none on a subdomain they show the icon of the parent
// domain instead.
const read = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url));

const svg = read("icon.svg");

const FILES: Record<string, { type: string; data: Buffer }> = {
  "/favicon.ico": { type: "image/x-icon", data: read("favicon.ico") },
  "/icon.svg": { type: "image/svg+xml", data: svg },
  "/icon-192.png": { type: "image/png", data: read("icon-192.png") },
  "/icon-512.png": { type: "image/png", data: read("icon-512.png") },
  "/apple-touch-icon.png": { type: "image/png", data: read("apple-touch-icon.png") },
};

export const ICON_PATHS = Object.keys(FILES);

/** The icon as markup, for pages that show it inline. */
export const ICON_SVG = svg.toString("utf8").trim();

/** The tags that point browsers and crawlers at the icon files. */
export const ICON_LINKS = [
  `<link rel="icon" href="/favicon.ico" sizes="48x48">`,
  `<link rel="icon" href="/icon.svg" type="image/svg+xml" sizes="any">`,
  `<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">`,
  `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
].join("\n");

/** The icons an MCP client can show next to the server's name. */
export function mcpIcons(publicUrl: URL): { src: string; mimeType: string; sizes: string[] }[] {
  const at = (path: string) => new URL(path, publicUrl).href;
  return [
    { src: at("/icon-192.png"), mimeType: "image/png", sizes: ["192x192"] },
    { src: at("/icon-512.png"), mimeType: "image/png", sizes: ["512x512"] },
    { src: at("/icon.svg"), mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

export function sendIcon(req: Request, res: Response): void {
  const file = FILES[req.path]!;
  res.setHeader("Content-Type", file.type);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(file.data);
}
