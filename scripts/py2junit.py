"""Translate the regular parts of a pytest module into JUnit 5 Java.

Tailored to the trafilatura test-suite: known API calls are mapped to the Java port,
assignments/asserts/literals are translated, anything else becomes a TODO marker.
Usage: python3 py2junit.py tests/x_tests.py ClassName > ClassName.java
"""
import ast
import sys

SRC = ""


def seg(node):
    s = ast.get_source_segment(SRC, node) or ast.dump(node)
    return s.replace("*/", "* /")


def jstr(s):
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif o < 0x20 or o == 0x7F or 0xD800 <= o <= 0xDFFF:
            out.append("\\u%04x" % o)
        elif o > 0xFFFF:
            out.append(ch)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jbytes(b):
    try:
        text = b.decode("ascii")
        if all(0x20 <= ord(c) < 0x7F or c in "\n\r\t" for c in text):
            return "T.b(" + jstr(text) + ")"
    except UnicodeDecodeError:
        pass
    try:
        return "T.b(" + jstr(b.decode("utf-8")) + ")"
    except UnicodeDecodeError:
        return "new byte[] {" + ", ".join(str(x if x < 128 else x - 256) for x in b) + "}"


class Todo(Exception):
    pass


# known functions: name -> (java_prefix, return type, positional parameter names, kwargs style)
KW_CALLS = {
    "extract": ("Core.extract", "str"),
    "bare_extraction": ("Core.bare_extraction", "Document"),
    "extract_with_metadata": ("Core.extract_with_metadata", "Document"),
}
EXTRACT_KW_POSITIONS = ["url"]  # extract(filecontent, url, ...)

SIMPLE_CALLS = {
    # name: (java function, return type)
    "extract_meta_json": ("Metadata.extract_meta_json", "Document"),
    "normalize_authors": ("JsonMetadata.normalize_authors", "str"),
    "process_parent": ("JsonMetadata.process_parent", "Document"),
    "normalize_json": ("JsonMetadata.normalize_json", "str"),
    "extract_json_author": ("JsonMetadata.extract_json_author", "str"),
    "extract_json": ("JsonMetadata.extract_json", "Document"),
    "extract_json_parse_error": ("JsonMetadata.extract_json_parse_error", "Document"),
    "check_authors": ("Metadata.check_authors", "str"),
    "normalize_tags": ("Metadata.normalize_tags", "str"),
    "extract_url": ("Metadata.extract_url", "str"),
    "extract_title": ("Metadata.extract_title", "str"),
    "extract_metainfo": ("Metadata.extract_metainfo", "str"),
    "load_html": ("Utils.load_html", "Element"),
    "html2txt": ("Baseline.html2txt", "str"),
    "baseline": ("Baseline.baseline", "Triple"),
    "trim": ("Utils.trim", "str"),
    "sanitize": ("Utils.sanitize", "str"),
    "xmltotxt": ("Xml.xmltotxt", "str"),
    "tree_cleaning": ("Htmlprocessing.tree_cleaning", "Element"),
    "is_probably_readerable": ("ReadabilityLxml.is_probably_readerable", "bool"),
    "content_fingerprint": ("Deduplication.content_fingerprint", "str"),
}

EXTRACT_METADATA_PARAMS = ["filecontent", "default_url", "date_config", "extensive", "author_blacklist"]
EXTRACT_METADATA_DEFAULTS = ["null", "null", "null", "true", "null"]

KWARG_ALIASES = {}

STR_METHODS = {
    "startswith": ("startsWith", "bool"),
    "endswith": ("endsWith", "bool"),
    "lower": ("toLowerCase", "str"),
    "upper": ("toUpperCase", "str"),
}


class Translator:
    def __init__(self, html_alias="html", etree_alias="etree"):
        self.types = {}
        self.declared = set()
        self.html_alias = html_alias
        self.etree_alias = etree_alias
        self.module_names = {}

    # ------------------------------------------------------------- expressions
    def expr(self, node):
        """Return (code, type)."""
        if isinstance(node, ast.Constant):
            v = node.value
            if v is None:
                return "null", "None"
            if isinstance(v, bool):
                return ("true" if v else "false"), "bool"
            if isinstance(v, str):
                return jstr(v), "str"
            if isinstance(v, bytes):
                return jbytes(v), "bytes"
            if isinstance(v, int):
                if abs(v) > 2**31 - 1:
                    return f"{v}L", "int"
                return str(v), "int"
            if isinstance(v, float):
                return repr(v), "float"
        if isinstance(node, ast.Name):
            if node.id in self.types:
                return node.id, self.types[node.id]
            if node.id in self.module_names:
                return self.module_names[node.id]
            return node.id, "Object"
        if isinstance(node, ast.JoinedStr):
            parts = []
            for v in node.values:
                if isinstance(v, ast.Constant):
                    parts.append(jstr(v.value))
                elif isinstance(v, ast.FormattedValue):
                    if v.format_spec is not None or v.conversion not in (-1, None):
                        raise Todo()
                    code, t = self.expr(v.value)
                    parts.append(f"({code})" if t not in ("str",) else code if code.isidentifier() else f"({code})")
            if not parts:
                return '""', "str"
            if not parts[0].startswith('"'):
                parts.insert(0, '""')
            return " + ".join(parts), "str"
        if isinstance(node, ast.BinOp):
            left, lt = self.expr(node.left)
            right, rt = self.expr(node.right)
            if isinstance(node.op, ast.Add):
                if lt == "str" or rt == "str":
                    return f"{left} + {right}", "str"
                if lt == "int" and rt == "int":
                    return f"{left} + {right}", "int"
            if isinstance(node.op, ast.Mult):
                if lt == "str" and rt == "int":
                    return f"{self.paren(left)}.repeat({right})", "str"
                if lt == "int" and rt == "str":
                    return f"{self.paren(right)}.repeat({left})", "str"
                if lt == "int" and rt == "int":
                    return f"{left} * {right}", "int"
            if isinstance(node.op, ast.Sub) and lt == "int" and rt == "int":
                return f"{left} - {right}", "int"
            if isinstance(node.op, ast.Mod) and lt == "str":
                if isinstance(node.right, ast.Tuple):
                    args = ", ".join(self.expr(e)[0] for e in node.right.elts)
                else:
                    args = right
                return f"{self.paren(left)}.formatted({args})", "str"
            raise Todo()
        if isinstance(node, ast.List) or isinstance(node, ast.Tuple):
            items = [self.expr(e) for e in node.elts]
            codes = ", ".join(c for c, _ in items)
            types = {t for _, t in items}
            if types <= {"str"} and items:
                return f"List.of({codes})", "list[str]"
            if types <= {"str", "None"} and items:
                return f"T.t({codes})", "list[str]"
            if not items:
                return "List.of()", "list"
            return f"T.list({codes})", "list"
        if isinstance(node, ast.Set):
            items = [self.expr(e) for e in node.elts]
            return "Set.of(" + ", ".join(c for c, _ in items) + ")", "set"
        if isinstance(node, ast.Dict):
            parts = []
            for k, v in zip(node.keys, node.values):
                if k is None:
                    raise Todo()
                parts.append(self.expr(k)[0])
                parts.append(self.expr(v)[0])
            return "T.map(" + ", ".join(parts) + ")", "dict"
        if isinstance(node, ast.Attribute):
            base, bt = self.expr(node.value)
            if bt == "Document":
                return f"{base}.{node.attr}", ("list[str]" if node.attr in ("categories", "tags") else
                                              "Element" if node.attr in ("body", "commentsbody") else "str")
            if bt == "Element" and node.attr in ("text", "tail", "tag"):
                return f"{base}.{node.attr}", "str"
            if bt == "Element" and node.attr == "attrib":
                return f"{base}.attrib", "dict"
            if bt == "module":
                raise Todo()
            return f"{base}.{node.attr}", "Object"
        if isinstance(node, ast.Subscript):
            base, bt = self.expr(node.value)
            if isinstance(node.slice, ast.Slice):
                if bt == "str":
                    lo = self.expr(node.slice.lower)[0] if node.slice.lower else "null"
                    hi = self.expr(node.slice.upper)[0] if node.slice.upper else "null"
                    return f"Py.slice({base}, {lo}, {hi})", "str"
                raise Todo()
            idx, it = self.expr(node.slice)
            if bt == "Triple":
                names = {"0": "first()", "1": "second()", "2": "third()"}
                return f"{base}.{names[idx]}", {"0": "Element", "1": "str", "2": "int"}[idx]
            if bt == "Pair":
                names = {"0": "first()", "1": "second()"}
                return f"{base}.{names[idx]}", "Object"
            if bt in ("list[str]",):
                return f"{base}.get({idx})", "str"
            if bt == "Element":
                return f"{base}.get({idx})", "Element"
            if bt == "dict":
                return f"{base}.get({idx})", "Object"
            if bt == "str":
                return f"String.valueOf({base}.charAt({idx}))", "str"
            raise Todo()
        if isinstance(node, ast.Call):
            return self.call(node)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            c, t = self.expr(node.operand)
            return f"-{c}", t
        if isinstance(node, ast.Compare) or isinstance(node, ast.BoolOp) or isinstance(node, ast.UnaryOp):
            return self.cond(node), "bool"
        raise Todo()

    def paren(self, code):
        return code if code.replace(".", "").replace("_", "").isalnum() or code.startswith('"') and code.endswith('"') else f"({code})"

    def kwargs_chain(self, keywords):
        chain = ""
        for kw in keywords:
            if kw.arg is None:
                raise Todo()
            value, _ = self.expr(kw.value)
            if kw.arg == "prune_xpath" and isinstance(kw.value, ast.List):
                value = value
            chain += f".{kw.arg}({value})"
        return chain

    def call(self, node):
        fn = node.func
        name = None
        owner = None
        if isinstance(fn, ast.Name):
            name = fn.id
        elif isinstance(fn, ast.Attribute):
            name = fn.attr
            if isinstance(fn.value, ast.Name):
                owner = fn.value.id
        # lxml parsers
        if name == "fromstring" and (owner == self.html_alias or (owner is None and self.module_names.get("fromstring") == "html")):
            args = [self.expr(a)[0] for a in node.args]
            return f"Etree.html_fromstring({args[0]})", "Element"
        if name == "fromstring" and (owner == self.etree_alias or owner is None):
            args = [self.expr(a)[0] for a in node.args]
            return f"Etree.fromstring({args[0]})", "Element"
        if name == "tostring":
            args = [self.expr(a)[0] for a in node.args]
            enc = None
            for kw in node.keywords:
                if kw.arg == "encoding":
                    enc = self.expr(kw.value)[0]
                else:
                    raise Todo()
            if enc is None:
                return f"Etree.tostring({args[0]})", "str"
            return f'Etree.tostring({args[0]}, "unicode")', "str"
        if name == "Document" and owner is None:
            if node.args:
                raise Todo()
            if node.keywords:
                parts = []
                for kw in node.keywords:
                    parts.append(jstr(kw.arg))
                    parts.append(self.expr(kw.value)[0])
                return "T.document(" + ", ".join(parts) + ")", "Document"
            return "new Document()", "Document"
        if name in KW_CALLS and owner is None:
            jfn, rt = KW_CALLS[name]
            args = [self.expr(a)[0] for a in node.args]
            chain = ""
            for extra, pname in zip(args[1:], EXTRACT_KW_POSITIONS):
                chain += f".{pname}({extra})"
            chain += self.kwargs_chain(node.keywords)
            if chain:
                return f"{jfn}({args[0]}, Core.kw(){chain})", rt
            return f"{jfn}({args[0]})", rt
        if name == "extract_metadata" and owner is None:
            values = list(EXTRACT_METADATA_DEFAULTS)
            for i, a in enumerate(node.args):
                values[i] = self.expr(a)[0]
            for kw in node.keywords:
                values[EXTRACT_METADATA_PARAMS.index(kw.arg)] = self.expr(kw.value)[0]
            return f"Metadata.extract_metadata({', '.join(values)})", "Document"
        if name in SIMPLE_CALLS and owner is None:
            if node.keywords:
                raise Todo()
            jfn, rt = SIMPLE_CALLS[name]
            args = [self.expr(a)[0] for a in node.args]
            return f"{jfn}({', '.join(args)})", rt
        if owner == "json" and name in ("dumps", "loads"):
            args = [self.expr(a)[0] for a in node.args]
            if node.keywords:
                raise Todo()
            return f"Json.{name}({args[0]})", ("str" if name == "dumps" else "Object")
        if name == "len" and owner is None:
            c, t = self.expr(node.args[0])
            if t == "str":
                return f"{c}.length()", "int"
            if t in ("list", "list[str]", "Element", "set", "dict"):
                return f"{c}.size()", "int"
            raise Todo()
        if isinstance(fn, ast.Attribute):
            base, bt = self.expr(fn.value)
            if bt == "str" and name in STR_METHODS:
                jm, rt = STR_METHODS[name]
                args = [self.expr(a)[0] for a in node.args]
                return f"{base}.{jm}({', '.join(args)})", rt
            if bt == "str" and name == "count":
                return f"T.count({base}, {self.expr(node.args[0])[0]})", "int"
            if bt == "str" and name == "strip" and not node.args:
                return f"Py.strip({base})", "str"
            if bt == "Element" and name in ("find",):
                return f"{base}.find({self.expr(node.args[0])[0]})", "Element"
            if bt == "Element" and name in ("findall", "xpath"):
                return f"{base}.{name}({self.expr(node.args[0])[0]})", "list"
            if bt == "Element" and name in ("text_content",):
                return f"{base}.text_content()", "str"
            if bt == "Document" and name == "as_dict":
                return f"{base}.as_dict()", "dict"
            if bt == "dict" and name == "get":
                return f"{base}.get({self.expr(node.args[0])[0]})", "Object"
        raise Todo()

    # ------------------------------------------------------------- conditions
    def cond(self, node):
        if isinstance(node, ast.BoolOp):
            op = " && " if isinstance(node.op, ast.And) else " || "
            return "(" + op.join(self.cond(v) for v in node.values) + ")"
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return f"!{self.paren(self.cond(node.operand))}"
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, lt = self.expr(node.left)
            right, rt = self.expr(node.comparators[0])
            op = node.ops[0]
            if isinstance(op, (ast.Is, ast.Eq)) and right == "null":
                return f"{left} == null"
            if isinstance(op, (ast.IsNot, ast.NotEq)) and right == "null":
                return f"{left} != null"
            if isinstance(op, ast.Eq):
                return f"java.util.Objects.equals({left}, {right})"
            if isinstance(op, ast.NotEq):
                return f"!java.util.Objects.equals({left}, {right})"
            if isinstance(op, ast.In):
                if rt == "str":
                    return f"{right}.contains({left})"
                return f"{right}.contains({left})"
            if isinstance(op, ast.NotIn):
                return f"!{right}.contains({left})"
            if isinstance(op, (ast.Gt, ast.Lt, ast.GtE, ast.LtE)):
                sym = {ast.Gt: ">", ast.Lt: "<", ast.GtE: ">=", ast.LtE: "<="}[type(op)]
                return f"{left} {sym} {right}"
            if isinstance(op, ast.Is) and right in ("true", "false"):
                return left if right == "true" else f"!{left}"
            raise Todo()
        code, t = self.expr(node)
        if t == "bool":
            return code
        return f"Py.truthy({code})"

    # ------------------------------------------------------------- statements
    def assertion(self, node):
        test = node.test
        msg = f", {self.expr(node.msg)[0]}" if node.msg is not None else ""
        if isinstance(test, ast.Compare) and len(test.ops) == 1:
            left, lt = self.expr(test.left)
            right, rt = self.expr(test.comparators[0])
            op = test.ops[0]
            if isinstance(op, (ast.Is, ast.Eq)) and right == "null":
                return f"assertNull({left}{msg});"
            if isinstance(op, (ast.IsNot, ast.NotEq)) and right == "null":
                return f"assertNotNull({left}{msg});"
            if isinstance(op, ast.Is) and right == "true":
                return f"assertTrue({left}{msg});"
            if isinstance(op, ast.Is) and right == "false":
                return f"assertFalse({left}{msg});"
            if isinstance(op, ast.Eq):
                return f"assertEquals({right}, {left}{msg});"
            if isinstance(op, ast.NotEq):
                return f"assertNotEquals({right}, {left}{msg});"
            if isinstance(op, ast.In):
                return f"assertTrue({right}.contains({left}){msg});"
            if isinstance(op, ast.NotIn):
                return f"assertFalse({right}.contains({left}){msg});"
            if isinstance(op, (ast.Gt, ast.Lt, ast.GtE, ast.LtE)):
                return f"assertTrue({self.cond(test)}{msg});"
            if isinstance(op, ast.Is):
                return f"assertSame({right}, {left}{msg});"
            if isinstance(op, ast.IsNot):
                return f"assertNotSame({right}, {left}{msg});"
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            return f"assertFalse({self.cond(test.operand)}{msg});"
        return f"assertTrue({self.cond(test)}{msg});"

    JAVA_TYPES = {"str": "String", "int": "int", "bool": "boolean", "Document": "Document", "Element": "Element",
                  "list[str]": "List<String>", "list": "List<Object>", "dict": "Map<String, Object>", "bytes": "byte[]",
                  "Triple": "Triple<Element, String, Integer>", "float": "double", "set": "Set<Object>"}

    def assign(self, node):
        if len(node.targets) != 1:
            raise Todo()
        target = node.targets[0]
        if isinstance(target, ast.Name):
            code, t = self.expr(node.value)
            name = target.id
            if name in self.declared:
                return f"{name} = {code};"
            self.declared.add(name)
            self.types[name] = t
            jt = self.JAVA_TYPES.get(t, "Object" if t in ("None", "Object") else "var")
            return f"{jt} {name} = {code};"
        if isinstance(target, ast.Attribute):
            base, bt = self.expr(target.value)
            code, t = self.expr(node.value)
            return f"{base}.{target.attr} = {code};"
        if isinstance(target, ast.Tuple):
            code, t = self.expr(node.value)
            if t == "Triple" and len(target.elts) == 3:
                names = [e.id if isinstance(e, ast.Name) else None for e in target.elts]
                tmp = f"_t{node.lineno}"
                lines = [f"Triple<Element, String, Integer> {tmp} = {code};"]
                for n, getter, jt, pt in zip(names, ["first()", "second()", "third()"],
                                             ["Element", "String", "int"], ["Element", "str", "int"]):
                    if n and n != "_":
                        if n in self.declared:
                            lines.append(f"{n} = {tmp}.{getter};")
                        else:
                            self.declared.add(n)
                            self.types[n] = pt
                            lines.append(f"{jt} {n} = {tmp}.{getter};")
                return "\n".join(lines)
        raise Todo()

    def stmt(self, node, indent):
        pad = "    " * indent
        try:
            if isinstance(node, ast.Assert):
                return pad + self.assertion(node)
            if isinstance(node, ast.Assign):
                return "\n".join(pad + line for line in self.assign(node).split("\n"))
            if isinstance(node, ast.Expr):
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    return None  # docstring
                code, _ = self.expr(node.value)
                return pad + code + ";"
            if isinstance(node, ast.Pass):
                return pad + "// pass"
        except Todo:
            pass
        except (KeyError, IndexError, AttributeError, ValueError):
            pass
        text = seg(node)
        lines = text.split("\n")
        return pad + "/* TODO py:\n" + "\n".join(pad + "   " + line for line in lines) + "\n" + pad + "*/"

    def function(self, node, indent=1):
        pad = "    " * indent
        self.types = {}
        self.declared = set()
        out = []
        doc = ast.get_docstring(node)
        decorators = [seg(d) for d in node.decorator_list]
        if doc:
            out.append(pad + "/** " + doc.replace("*/", "* /").replace("\n", "\n" + pad + " * ") + " */")
        for d in decorators:
            out.append(pad + "// TODO decorator: @" + d)
        params = [a.arg for a in node.args.args]
        if node.name.startswith("test"):
            out.append(pad + "@Test")
            out.append(pad + f"void {node.name}({', '.join('Object ' + p for p in params)}) {{")
        else:
            out.append(pad + f"static Object {node.name}({', '.join('Object ' + p for p in params)}) {{")
        for st in node.body:
            line = self.stmt(st, indent + 1)
            if line is not None:
                out.append(line)
        out.append(pad + "}")
        return "\n".join(out)


def main():
    global SRC
    path, cls = sys.argv[1], sys.argv[2]
    SRC = open(path, encoding="utf-8").read()
    tree = ast.parse(SRC)
    tr = Translator()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "lxml.html":
            for alias in node.names:
                if alias.name == "fromstring":
                    tr.module_names["fromstring"] = "html"
    body = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            body.append(tr.function(node))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            continue
        else:
            body.append("    /* TODO module-level py:\n" + "\n".join("       " + l for l in seg(node).split("\n")) + "\n    */")
    doc = ast.get_docstring(tree) or ""
    print(f"// Java port of {path.split('/')[-2]}/{path.split('/')[-1]}")
    print("package trafilatura.tests;\n")
    print(IMPORTS)
    print(f"/** {doc.strip()} */")
    print(f"class {cls} {{")
    print("\n\n".join(body))
    print("}")


IMPORTS = """import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

import trafilatura.compat.Json;
import trafilatura.compat.Py;
import trafilatura.compat.Triple;
import trafilatura.lxml.Element;
import trafilatura.lxml.Etree;
import trafilatura.trafilatura.Baseline;
import trafilatura.trafilatura.Core;
import trafilatura.trafilatura.Deduplication;
import trafilatura.trafilatura.Htmlprocessing;
import trafilatura.trafilatura.JsonMetadata;
import trafilatura.trafilatura.Metadata;
import trafilatura.trafilatura.ReadabilityLxml;
import trafilatura.trafilatura.Settings.Document;
import trafilatura.trafilatura.Utils;
import trafilatura.trafilatura.Xml;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
"""

if __name__ == "__main__":
    main()
