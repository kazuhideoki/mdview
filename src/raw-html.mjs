import { escape } from "html-escaper";
import { parseFragment, serialize } from "parse5";
import { SAXParser } from "parse5-sax-parser";

const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "center", "code", "del", "details", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd", "li", "mark",
  "ol", "p", "pre", "s", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);

export async function sanitizeRawHtml(value = "", { resolveImage } = {}) {
  const tokens = parseRawHtml(value);
  const html = [];
  for (const token of tokens) {
    if (token.type === "text") {
      html.push(escape(token.value));
      continue;
    }
    if (token.type === "end") {
      if (ALLOWED_TAGS.has(token.tagName) && !VOID_TAGS.has(token.tagName)) html.push(`</${token.tagName}>`);
      continue;
    }
    if (!ALLOWED_TAGS.has(token.tagName)) continue;
    const attributes = sanitizeAttributes(token.tagName, token.attrs);
    if (token.tagName === "img" && resolveImage) {
      const source = attributes.find((attribute) => attribute.name === "src");
      if (source) source.value = await resolveImage(source.value);
    }
    const serialized = attributes.map((attribute) => (
      attribute.value === true ? attribute.name : `${attribute.name}="${escape(attribute.value)}"`
    )).join(" ");
    html.push(`<${token.tagName}${serialized ? ` ${serialized}` : ""}>`);
  }
  return html.join("");
}

export function normalizeHtmlFragment(value = "") {
  return serialize(parseFragment(value));
}

function parseRawHtml(value) {
  const tokens = [];
  const parser = new SAXParser();
  parser.on("startTag", ({ tagName, attrs }) => tokens.push({ type: "start", tagName, attrs }));
  parser.on("endTag", ({ tagName }) => tokens.push({ type: "end", tagName }));
  parser.on("text", ({ text }) => tokens.push({ type: "text", value: text }));
  parser.end(value);
  return tokens;
}

function sanitizeAttributes(tag, attributes) {
  const allowed = new Set([
    "align", "title",
    ...(tag === "a" ? ["href"] : []),
    ...(tag === "img" ? ["src", "alt", "width", "height"] : []),
    ...(tag === "ol" ? ["start"] : []),
    ...(tag === "li" ? ["value"] : []),
    ...(["td", "th"].includes(tag) ? ["colspan", "rowspan"] : []),
    ...(tag === "details" ? ["open"] : []),
  ]);
  const sanitized = [];
  const seen = new Set();
  for (const attribute of attributes) {
    const name = attribute.name.toLowerCase();
    if (!allowed.has(name) || seen.has(name)) continue;
    const value = sanitizeAttributeValue(name, attribute.value);
    if (value === null) continue;
    seen.add(name);
    sanitized.push({ name, value });
  }
  return sanitized;
}

function sanitizeAttributeValue(name, value) {
  if (name === "open") return value === "" || value.toLowerCase() === "open" ? true : null;
  if (["href", "src"].includes(name)) {
    const compact = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
    return /^(?:javascript|vbscript|data):/.test(compact) ? "#" : value;
  }
  if (name === "align") return /^(?:left|right|center|justify)$/i.test(value) ? value.toLowerCase() : null;
  if (["width", "height"].includes(name)) return /^\d{1,4}%?$/.test(value) ? value : null;
  if (["start", "value"].includes(name)) return /^-?\d{1,9}$/.test(value) ? value : null;
  if (["colspan", "rowspan"].includes(name)) return /^\d{1,3}$/.test(value) ? value : null;
  return value;
}
