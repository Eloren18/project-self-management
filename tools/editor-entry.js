// Entry point for the vendored rich-text editor bundle (vendor/tiptap.js).
// Build: npm run build:editor   (esbuild → one minified IIFE that sets window.Tiptap)
//
// index.html loads vendor/tiptap.js with a plain <script> tag (CSP: script-src 'self'),
// so the app works offline / from file:// and never pulls editor code from a CDN.
// Everything the app touches is re-exported here; the app itself only ever uses
// window.Tiptap.* — see bindRichEditor() / psmEditorExtensions() in index.html.
import { Editor, Extension, Node, Mark } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { BulletList, OrderedList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { DOMParser as PMDOMParser, DOMSerializer as PMDOMSerializer } from "@tiptap/pm/model";
import { canJoin, liftTarget } from "@tiptap/pm/transform";

export { Editor, Extension, Node, Mark, StarterKit, BulletList, OrderedList, Placeholder, Highlight, TextAlign, PMDOMParser, PMDOMSerializer, canJoin, liftTarget };
export const version = "3.31.3";
