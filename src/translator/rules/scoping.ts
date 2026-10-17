/**
 * Python locals live for the whole function; a Java local only for the block it is declared in.
 * A name first assigned inside an `if`, `else`, `try`, `with` or `while` body but used after it
 * (or in a sibling branch) is therefore declared earlier, at the point that encloses every use:
 *
 *   if ok:                     Object label = null;
 *       label = "yes"          if (ok) {
 *   else:                          label = "yes";
 *       label = "no"           } else {
 *   print(label)                   label = "no";
 *                              }
 *                              System.out.println(label);
 *
 * This module only plans where; the translator emits the declarations. A declaration never goes
 * inside a loop body (Python keeps the value from one iteration to the next) nor directly in a
 * `match`. Loop targets and `with`/`except` names keep their own scope.
 */

import { LogicalLine } from './logicalLines';
import { maskStrings } from './strings';
import { splitTopLevel } from './typeHints';

/** A local declared ahead of its first assignment. */
export interface HoistedLocal {
  name: string;
  /** Every value assigned to it, masked, with its string literals (undefined for an unpacking target). */
  values: Array<MaskedValue | undefined>;
}

export interface MaskedValue {
  masked: string;
  literals: string[];
}

interface Occurrence {
  line: number;
  /** Indices of the headers of the blocks around the occurrence, outermost first. */
  path: number[];
  assigns: boolean;
  value?: MaskedValue;
}

const CLAUSE = /^(elif|else|except|finally)\b/;
const LOOP = /^(async\s+)?(for|while)\b/;
/** A `match` body holds only `case` arms (a Java `switch` body only `case` labels). */
const MATCH = /^match\b/;
const NAME = /(?<![\w.\u0001])[A-Za-z_]\w*(?![\w\u0001])/g;

/** Index of the first `=` that assigns (not `==`, `<=`, `>=`, `!=`, `:=`, not inside brackets). */
function assignmentAt(code: string, from = 0): number {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const ch = code[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === '=' && depth === 0 && code[i + 1] !== '=' && !'=<>!:+-*/%&|^@'.includes(code[i - 1] ?? '')) return i;
  }
  return -1;
}

/** The plain names an assignment target binds: `a`, `a, (b, *c)`; none for `self.x` or `d[k]`. */
function targetNames(target: string): string[] {
  let t = target.trim().replace(/:\s*.+$/, ''); // `x: int`
  if (/^[(\[]/.test(t) && /[)\]]$/.test(t)) t = t.slice(1, -1);
  const parts = splitTopLevel(t).map((p) => p.trim().replace(/^\*/, '')).filter(Boolean);
  if (parts.length === 1 && parts[0] === t.trim().replace(/^\*/, '')) return /^[A-Za-z_]\w*$/.test(parts[0]) ? [parts[0]] : [];
  return parts.flatMap((p) => targetNames(p));
}

/** Header part and inline body of `if x: y = 1`, or undefined when `code` is not a one-line compound. */
function oneLiner(code: string): { header: string; body: string } | undefined {
  if (!/^(async\s+)?(if|elif|else|for|while|try|except|finally|with)\b/.test(code) || code.endsWith(':')) return undefined;
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ':' && depth === 0 && !/lambda[^:]*$/.test(code.slice(0, i))) return { header: code.slice(0, i), body: code.slice(i + 1).trim() };
  }
  return undefined;
}

/**
 * Locals of the function whose header is `lines[header]` that must be declared ahead, keyed by
 * the index of the line to declare them before. `params` are already declared.
 */
export function planHoistedLocals(lines: LogicalLine[], header: number, params: Set<string>): Map<number, HoistedLocal[]> {
  const top = lines[header].indent;
  const occurrences = new Map<string, Occurrence[]>();
  const skip = new Set<string>(params);
  const stack: Array<{ indent: number; line: number }> = [];
  let nested = -1;

  const record = (text: string, line: number, path: number[], literals: string[]) => {
    const bound = new Set<string>();
    // Names bound inside the statement itself: comprehension and lambda parameters.
    for (const m of text.matchAll(/\bfor\s+([\w\s,()*]+?)\s+in\b/g)) for (const n of targetNames(m[1])) bound.add(n);
    for (const m of text.matchAll(/\blambda\s*([^:]*):/g)) for (const p of m[1].split(',')) bound.add(p.trim().replace(/^\*+/, '').replace(/=.*$/, '').trim());
    let assigned: string[] = [];
    let value: MaskedValue | undefined;
    const eq = /^(global|nonlocal)\s/.test(text) ? -1 : assignmentAt(text);
    if (eq > 0) {
      const targets: string[] = [];
      let rest = text;
      for (let at = eq; at > 0; at = assignmentAt(rest)) {
        targets.push(rest.slice(0, at));
        rest = rest.slice(at + 1);
      }
      assigned = targets.flatMap(targetNames);
      value = targets.length === 1 && targetNames(targets[0]).length === 1 && !/,/.test(targets[0]) ? { masked: rest.trim(), literals } : undefined;
    }
    const seen = new Set<string>();
    for (const m of text.matchAll(NAME)) {
      const name = m[0];
      if (bound.has(name) || seen.has(name)) continue;
      // `f(name=1)` names a parameter of f.
      if (/^\s*=(?!=)/.test(text.slice(m.index! + name.length)) && !assigned.includes(name)) continue;
      seen.add(name);
      const list = occurrences.get(name) ?? [];
      list.push({ line, path, assigns: assigned.includes(name), value: assigned.includes(name) ? value : undefined });
      occurrences.set(name, list);
    }
  };

  for (let j = header + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.kind !== 'code') continue;
    if (l.indent <= top) break;
    if (nested >= 0 && l.indent > nested) continue;
    nested = -1;
    while (stack.length && stack[stack.length - 1].indent >= l.indent) stack.pop();
    const masked = maskStrings(l.text);
    const hash = masked.text.indexOf('#');
    const code = (hash < 0 ? masked.text : masked.text.slice(0, hash)).trim();
    const path = stack.map((s) => s.line);
    if (/^(async\s+)?(def|class)\s/.test(code)) {
      nested = l.indent;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(?:global|nonlocal)\s+(.+)$/.exec(code))) m[1].split(',').forEach((n) => skip.add(n.trim()));
    if ((m = /^(?:async\s+)?for\s+(.+?)\s+in\s/.exec(code))) targetNames(m[1]).forEach((n) => skip.add(n));
    for (const as of code.matchAll(/\bas\s+(\w+)/g)) skip.add(as[1]);

    const inline = oneLiner(code);
    if (inline) {
      record(inline.header, j, path, masked.literals);
      record(inline.body, j, [...path, j], masked.literals);
      continue;
    }
    record(code, j, path, masked.literals);
    if (code.endsWith(':')) stack.push({ indent: l.indent, line: j });
  }

  /** The `if` / `try` / loop line that starts the chain a clause (`else:`, `except:`) belongs to. */
  const chainStart = (j: number): number => {
    let k = j;
    while (CLAUSE.test(lines[k].text.trim())) {
      let p = k - 1;
      while (p > header && (lines[p].kind !== 'code' || lines[p].indent !== lines[k].indent)) p -= 1;
      if (p <= header) break;
      k = p;
    }
    return k;
  };

  const plan = new Map<number, HoistedLocal[]>();
  for (const [name, list] of occurrences) {
    if (skip.has(name) || !list[0].assigns || list[0].path.length === 0) continue;
    const block = list[0].path[list[0].path.length - 1];
    if (list.every((o) => o.path.includes(block))) continue;
    // Declare in the deepest block around every use, but never inside a loop body (the value
    // must survive iterations) nor directly in a `match` (a switch body holds only cases).
    let common = list[0].path;
    for (const o of list) {
      let k = 0;
      while (k < common.length && k < o.path.length && common[k] === o.path[k]) k += 1;
      common = common.slice(0, k);
    }
    const loop = common.findIndex((h) => LOOP.test(lines[h].text.trim()) || MATCH.test(lines[h].text.trim()));
    if (loop >= 0) common = common.slice(0, loop);
    const before = chainStart(list[0].path[common.length]);
    const hoists = plan.get(before) ?? [];
    hoists.push({ name, values: list.filter((o) => o.assigns).map((o) => o.value) });
    plan.set(before, hoists);
  }
  return plan;
}
