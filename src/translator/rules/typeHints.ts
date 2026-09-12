/**
 * Maps Python type hints to Java-flavored type names.
 *
 *   int -> int, str -> String, list[int] -> List<Integer>, dict[str, Any] -> Map<String, Object>,
 *   Optional[Order] -> Order /* nullable *\/, None -> void, Callable[[A, B], R] -> BiFunction<A, B, R>
 */

const PRIMITIVES: Record<string, string> = {
  int: 'int',
  float: 'double',
  bool: 'boolean',
  str: 'String',
  bytes: 'byte[]',
  complex: 'Complex',
  None: 'void',
  Any: 'Object',
  object: 'Object',
  Decimal: 'BigDecimal',
  datetime: 'LocalDateTime',
  date: 'LocalDate',
  timedelta: 'Duration',
  Path: 'Path',
  UUID: 'UUID',
};

const BOXED: Record<string, string> = {
  int: 'Integer',
  double: 'Double',
  boolean: 'Boolean',
  void: 'Void',
  char: 'Character',
};

const GENERICS: Record<string, string> = {
  list: 'List',
  List: 'List',
  Sequence: 'List',
  MutableSequence: 'List',
  tuple: 'Tuple',
  Tuple: 'Tuple',
  set: 'Set',
  Set: 'Set',
  frozenset: 'Set',
  FrozenSet: 'Set',
  dict: 'Map',
  Dict: 'Map',
  Mapping: 'Map',
  MutableMapping: 'Map',
  DefaultDict: 'Map',
  defaultdict: 'Map',
  OrderedDict: 'LinkedHashMap',
  Iterable: 'Iterable',
  Iterator: 'Iterator',
  Generator: 'Iterator',
  Collection: 'Collection',
  Deque: 'Deque',
  deque: 'Deque',
  Type: 'Class',
  type: 'Class',
  Awaitable: 'CompletableFuture',
  Coroutine: 'CompletableFuture',
  ClassVar: '',
  Final: 'final',
  Annotated: '',
};

export function boxed(t: string): string {
  return BOXED[t] ?? t;
}

/** Split a comma separated list at bracket depth 0. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '[' || ch === '(' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ']' || ch === ')' || ch === '}' || ch === '>') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

export function translateType(hint: string | undefined | null, opts: { box?: boolean } = {}): string {
  if (!hint) return 'Object';
  let h = hint.trim();
  // Forward references written as strings: "Order" -> Order
  h = h.replace(/^["'](.*)["']$/, '$1');
  if (h === '') return 'Object';

  // PEP 604 unions: A | None -> A /* nullable */ ; A | B -> Object /* A | B */
  const unionParts = splitTopLevel(h, '|');
  if (unionParts.length > 1) {
    const nonNull = unionParts.filter((p) => p !== 'None');
    if (nonNull.length === 1) {
      return `${translateType(nonNull[0], opts)} /* nullable */`;
    }
    return `Object /* ${unionParts.map((p) => translateType(p, opts)).join(' | ')} */`;
  }

  const generic = /^([\w.]+)\[(.*)\]$/.exec(h);
  if (generic) {
    const head = generic[1].replace(/^typing\./, '');
    const args = splitTopLevel(generic[2]);
    switch (head) {
      case 'Optional':
        return `${translateType(args[0], opts)} /* nullable */`;
      case 'Union': {
        const nonNull = args.filter((p) => p !== 'None');
        if (nonNull.length === 1) return `${translateType(nonNull[0], opts)} /* nullable */`;
        return `Object /* ${args.map((a) => translateType(a, opts)).join(' | ')} */`;
      }
      case 'Literal':
        return `Object /* one of ${args.join(', ')} */`;
      case 'Callable': {
        const params = args[0]?.replace(/^\[|\]$/g, '') ?? '';
        const ret = translateType(args[1], { box: true });
        const ps = params.trim() === '' || params.trim() === '...' ? [] : splitTopLevel(params).map((p) => translateType(p, { box: true }));
        if (ps.length === 0) return `Supplier<${ret}>`;
        if (ps.length === 1) return `Function<${ps[0]}, ${ret}>`;
        if (ps.length === 2) return `BiFunction<${ps[0]}, ${ps[1]}, ${ret}>`;
        return `Function<(${ps.join(', ')}), ${ret}>`;
      }
      case 'ClassVar':
      case 'Annotated':
        return translateType(args[0], opts);
      case 'Final':
        return `final ${translateType(args[0], opts)}`;
      default: {
        const javaHead = GENERICS[head] ?? head;
        const javaArgs = args.map((a) => (a === '...' ? '?' : translateType(a, { box: true })));
        return `${javaHead}<${javaArgs.join(', ')}>`;
      }
    }
  }

  const bare = h.replace(/^typing\./, '');
  if (bare in PRIMITIVES) {
    const t = PRIMITIVES[bare];
    return opts.box ? boxed(t) : t;
  }
  if (bare in GENERICS) {
    const g = GENERICS[bare];
    if (g === '') return 'Object';
    return g === 'Tuple' ? 'Tuple' : `${g}<?>`;
  }
  return bare;
}
