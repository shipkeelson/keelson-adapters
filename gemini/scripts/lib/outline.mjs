// Which functions an edit touches, worked out on the developer's machine so no code leaves it.
//
// This is a light scanner, not a parser: Python by indentation, JavaScript and TypeScript by braces. It names
// functions the way the server's footprints do (`applyDiscount`, `Cart.total`), and code outside any function
// as `<module>`. When it cannot tell, the edit is reported for the whole file, which is always safe: the server
// recomputes exact footprints with tree-sitter on every push.

const PY = /\.pyi?$/;
const JS = /\.(m|c)?(j|t)sx?$/;
const JS_SKIP = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with", "else", "do", "try", "new", "typeof", "await", "super", "constructor"]);

export function supported(path) {
  return PY.test(path) || JS.test(path);
}

// [{ name, start, end }] with 1-based inclusive line numbers; methods are qualified by their class.
export function outline(text, path) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (PY.test(path)) return outlinePython(lines);
  if (JS.test(path)) return outlineJs(lines);
  return [];
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function outlinePython(lines) {
  const found = [];
  const classes = []; // [{ name, indent, end }]
  const definition = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
  const endOf = (index, indent) => {
    let end = index;
    for (let i = index + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      if (indentOf(line) <= indent) break;
      end = i;
    }
    return end;
  };
  let insideFunction = -1; // functions nested in functions belong to the outer one
  for (let i = 0; i < lines.length; i++) {
    const match = definition.exec(lines[i]);
    if (!match || i <= insideFunction) continue;
    const indent = match[1].length;
    while (classes.length && (indent <= classes.at(-1).indent || i > classes.at(-1).end)) classes.pop();
    const end = endOf(i, indent);
    const qualified = [...classes.map((c) => c.name), match[3]].join(".");
    if (match[2] === "class") {
      classes.push({ name: match[3], indent, end });
      found.push({ name: qualified, start: i + 1, end: end + 1, kind: "class" });
    } else {
      found.push({ name: qualified, start: i + 1, end: end + 1, kind: "function" });
      insideFunction = end;
    }
  }
  return found;
}

// The index of the brace that closes the one at (line, col), skipping strings and comments.
function closingBrace(lines, line, col) {
  let depth = 0;
  let quote = null;
  let block = false;
  for (let i = line; i < lines.length; i++) {
    const text = lines[i];
    for (let j = i === line ? col : 0; j < text.length; j++) {
      const ch = text[j];
      if (block) {
        if (ch === "*" && text[j + 1] === "/") { block = false; j++; }
        continue;
      }
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && text[j + 1] === "/") break;
      if (ch === "/" && text[j + 1] === "*") { block = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return i;
    }
    if (quote && quote !== "`") quote = null; // an unclosed quote ends with its line
  }
  return lines.length - 1;
}

function firstBrace(lines, line, from) {
  for (let i = line; i < Math.min(lines.length, line + 6); i++) {
    const at = lines[i].indexOf("{", i === line ? from : 0);
    if (at >= 0) return [i, at];
    if (i > line && /;\s*$/.test(lines[i])) return null;
  }
  return null;
}

function outlineJs(lines) {
  const found = [];
  const classes = []; // [{ name, end }]
  const declaration = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
    /^\s*(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)/,
  ];
  const method = /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/;
  let skipTo = -1;
  for (let i = 0; i < lines.length; i++) {
    while (classes.length && i > classes.at(-1).end) classes.pop();
    if (i <= skipTo) continue;
    const text = lines[i];
    let kind = null;
    let name = null;
    for (const pattern of declaration) {
      const match = pattern.exec(text);
      if (match) { kind = match[1] === "class" ? "class" : "function"; name = match[2]; break; }
    }
    if (!name && classes.length) {
      const match = method.exec(text);
      if (match && !JS_SKIP.has(match[1])) { kind = "function"; name = match[1]; }
    }
    if (!name) continue;
    const brace = firstBrace(lines, i, 0);
    let end = i;
    if (brace) end = closingBrace(lines, brace[0], brace[1]);
    else if (kind === "function") end = i; // `const f = (x) => x + 1`
    else continue;
    const qualified = kind === "function" && classes.length ? `${classes.at(-1).name}.${name}` : name;
    found.push({ name: qualified, start: i + 1, end: end + 1, kind });
    if (kind === "class") classes.push({ name, end });
    else skipTo = end; // a function's own inner functions belong to it
  }
  return found;
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// The innermost named units (methods before their class) covering lines a..b; `<module>` for the rest.
function namesFor(units, a, b) {
  const hits = units.filter((u) => u.start <= b && u.end >= a);
  const functions = hits.filter((u) => u.kind === "function");
  if (functions.length) return functions.map((u) => u.name);
  const classes = hits.filter((u) => u.kind === "class");
  if (classes.length) return [classes.at(-1).name];
  return ["<module>"];
}

// Functions an Edit (old_string -> new_string) or MultiEdit changes in `text`, the file before the edit.
// null: report the whole file (the text was not found, or the language is not one we scan).
export function editedFunctions(path, text, edits) {
  if (!supported(path) || typeof text !== "string") return null;
  const normal = text.replace(/\r\n?/g, "\n");
  const units = outline(normal, path);
  const names = new Set();
  for (const edit of edits) {
    const old = String(edit.old_string ?? "").replace(/\r\n?/g, "\n");
    if (!old) return null;
    let at = normal.indexOf(old);
    if (at < 0) return null;
    do {
      const a = lineOf(normal, at);
      const b = a + old.split("\n").length - 1;
      for (const name of namesFor(units, a, b)) names.add(name);
      at = edit.replace_all ? normal.indexOf(old, at + old.length) : -1;
    } while (at >= 0);
  }
  return [...names].sort();
}

// Functions a Write changes: those whose text differs, appeared or disappeared, plus `<module>` when code outside
// functions changed. null for a new file or an unscanned language (the whole file).
export function writtenFunctions(path, before, after) {
  if (!supported(path) || typeof before !== "string") return null;
  const a = before.replace(/\r\n?/g, "\n");
  const b = String(after ?? "").replace(/\r\n?/g, "\n");
  const bodies = (text) => {
    const lines = text.split("\n");
    const map = new Map();
    const covered = new Set();
    for (const unit of outline(text, path)) {
      if (unit.kind !== "function") continue;
      map.set(unit.name, lines.slice(unit.start - 1, unit.end).join("\n"));
      for (let i = unit.start - 1; i < unit.end; i++) covered.add(i);
    }
    const rest = lines.filter((_, i) => !covered.has(i)).join("\n");
    return [map, rest];
  };
  const [oldMap, oldRest] = bodies(a);
  const [newMap, newRest] = bodies(b);
  const names = new Set();
  for (const name of new Set([...oldMap.keys(), ...newMap.keys()])) if (oldMap.get(name) !== newMap.get(name)) names.add(name);
  if (oldRest.trim() !== newRest.trim()) names.add("<module>");
  return [...names].sort();
}
