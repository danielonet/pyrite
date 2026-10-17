// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;

/**
 * Python's {@code re} module for translated code: Python pattern syntax ({@code (?P<name>...)},
 * {@code (?P=name)}, {@code \Z}), Python results ({@code match} anchored at the start,
 * {@code findall} returning groups, {@code split} keeping groups, {@code sub} with {@code \1} or a
 * function) and {@code null} where Python returns {@code None}.
 */
public final class Re {
    private Re() {}

    public static final int A = 256, ASCII = A;
    public static final int I = 2, IGNORECASE = I;
    public static final int L = 4, LOCALE = L;
    public static final int M = 8, MULTILINE = M;
    public static final int S = 16, DOTALL = S;
    public static final int U = 32, UNICODE = U;
    public static final int X = 64, VERBOSE = X;

    private static final Map<String, Pattern> CACHE = new HashMap<>();

    /** {@code re.compile(pattern[, flags])}. A compiled pattern is returned as it is. */
    public static Pattern compile(Object pattern, Object... flags) {
        if (pattern instanceof Pattern p) return p;
        int f = flags.length > 0 && flags[0] != null ? ((Number) flags[0]).intValue() : 0;
        return CACHE.computeIfAbsent(f + ":" + pattern, key -> new Pattern(String.valueOf(pattern), f));
    }

    public static Match match(Object pattern, Object string, Object... flags) {
        return compile(pattern, flags).match(string);
    }

    public static Match fullmatch(Object pattern, Object string, Object... flags) {
        return compile(pattern, flags).fullmatch(string);
    }

    public static Match search(Object pattern, Object string, Object... flags) {
        return compile(pattern, flags).search(string);
    }

    public static List<Object> findall(Object pattern, Object string, Object... flags) {
        return compile(pattern, flags).findall(string);
    }

    public static List<Match> finditer(Object pattern, Object string, Object... flags) {
        return compile(pattern, flags).finditer(string);
    }

    /** {@code re.sub(pattern, repl, string[, count, flags])}. */
    public static String sub(Object pattern, Object repl, Object string, Object... countAndFlags) {
        Object[] flags = countAndFlags.length > 1 ? new Object[] {countAndFlags[1]} : new Object[0];
        return compile(pattern, flags).sub(repl, string, countAndFlags.length > 0 ? countAndFlags[0] : 0);
    }

    /** {@code re.split(pattern, string[, maxsplit, flags])}. */
    public static List<String> split(Object pattern, Object string, Object... maxsplitAndFlags) {
        Object[] flags = maxsplitAndFlags.length > 1 ? new Object[] {maxsplitAndFlags[1]} : new Object[0];
        return compile(pattern, flags).split(string, maxsplitAndFlags.length > 0 ? maxsplitAndFlags[0] : 0);
    }

    /** {@code re.escape(s)}: every character that is not a letter, digit or {@code _} gets a backslash. */
    public static String escape(Object s) {
        StringBuilder out = new StringBuilder();
        for (char c : String.valueOf(s).toCharArray()) {
            if (!Character.isLetterOrDigit(c) && c != '_') out.append('\\');
            out.append(c);
        }
        return out.toString();
    }

    public static void purge() {
        CACHE.clear();
    }

    /** A compiled Python regular expression. */
    public static final class Pattern {
        /** The Python source of the pattern. */
        public final String pattern;
        public final int flags;
        public final int groups;
        /** {@code p.groupindex}: named group -> number. */
        public final Map<String, Integer> groupindex = new LinkedHashMap<>();
        private final java.util.regex.Pattern compiled;

        Pattern(String pattern, int flags) {
            this.pattern = pattern;
            this.flags = flags;
            int javaFlags = 0;
            if ((flags & I) != 0) javaFlags |= java.util.regex.Pattern.CASE_INSENSITIVE;
            if ((flags & I) != 0 && (flags & A) == 0) javaFlags |= java.util.regex.Pattern.UNICODE_CASE;
            if ((flags & M) != 0) javaFlags |= java.util.regex.Pattern.MULTILINE;
            if ((flags & S) != 0) javaFlags |= java.util.regex.Pattern.DOTALL;
            if ((flags & X) != 0) javaFlags |= java.util.regex.Pattern.COMMENTS;
            if ((flags & A) == 0) javaFlags |= java.util.regex.Pattern.UNICODE_CHARACTER_CLASS;
            this.compiled = java.util.regex.Pattern.compile(toJava(pattern), javaFlags);
            this.groups = compiled.matcher("").groupCount();
        }

        /**
         * Python syntax to Java. Groups are numbered while converting: a named group
         * {@code (?P<name>...)} becomes a plain group (Java names allow no {@code _}) and
         * {@code (?P=name)} a reference by number; {@code \Z} is Java's {@code \z}.
         */
        private String toJava(String p) {
            StringBuilder out = new StringBuilder();
            int group = 0;
            boolean inClass = false;
            for (int i = 0; i < p.length(); i++) {
                char c = p.charAt(i);
                if (c == '\\' && i + 1 < p.length()) {
                    char n = p.charAt(++i);
                    out.append(n == 'Z' && !inClass ? "\\z" : "\\" + n);
                } else if (inClass) {
                    if (c == ']') inClass = false;
                    out.append(c);
                } else if (c == '[') {
                    inClass = true;
                    out.append(c);
                    // A `]` right after `[` or `[^` is a literal.
                    if (i + 1 < p.length() && p.charAt(i + 1) == '^') out.append(p.charAt(++i));
                    if (i + 1 < p.length() && p.charAt(i + 1) == ']') out.append(p.charAt(++i));
                } else if (p.startsWith("(?P<", i)) {
                    int close = p.indexOf('>', i);
                    groupindex.put(p.substring(i + 4, close), ++group);
                    out.append('(');
                    i = close;
                } else if (p.startsWith("(?P=", i)) {
                    int close = p.indexOf(')', i);
                    out.append("(?:\\").append(groupindex.get(p.substring(i + 4, close))).append(')');
                    i = close;
                } else {
                    if (c == '(' && !p.startsWith("(?", i)) group++;
                    out.append(c);
                }
            }
            return out.toString();
        }

        int groupNumber(Object group) {
            if (group instanceof Number n) return n.intValue();
            Integer k = groupindex.get(String.valueOf(group));
            if (k == null) throw new IndexOutOfBoundsException("no such group: " + group);
            return k;
        }

        /** {@code p.match(s)}: a match at the start of the string, or {@code null}. */
        public Match match(Object string) {
            String s = String.valueOf(string);
            Matcher m = compiled.matcher(s);
            return m.lookingAt() ? new Match(this, m, s) : null;
        }

        public Match fullmatch(Object string) {
            String s = String.valueOf(string);
            Matcher m = compiled.matcher(s);
            return m.matches() ? new Match(this, m, s) : null;
        }

        public Match search(Object string) {
            String s = String.valueOf(string);
            Matcher m = compiled.matcher(s);
            return m.find() ? new Match(this, m, s) : null;
        }

        /** {@code p.findall(s)}: the matches, or group 1 when there is one group, or tuples of the groups. */
        public List<Object> findall(Object string) {
            List<Object> out = new ArrayList<>();
            Matcher m = compiled.matcher(String.valueOf(string));
            while (m.find()) {
                if (groups == 0) out.add(m.group());
                else if (groups == 1) out.add(orEmpty(m.group(1)));
                else {
                    Object[] g = new Object[groups];
                    for (int k = 0; k < groups; k++) g[k] = orEmpty(m.group(k + 1));
                    out.add(Tuple.of(g));
                }
            }
            return out;
        }

        public List<Match> finditer(Object string) {
            String s = String.valueOf(string);
            List<Match> out = new ArrayList<>();
            Matcher m = compiled.matcher(s);
            while (m.find()) out.add(new Match(this, m, s));
            return out;
        }

        /**
         * {@code p.sub(repl, s[, count])}: {@code repl} is a string ({@code \1}, {@code \g<name>})
         * or a function of the match.
         */
        @SuppressWarnings("unchecked")
        public String sub(Object repl, Object string, Object... count) {
            int max = count.length > 0 && count[0] != null ? ((Number) count[0]).intValue() : 0;
            String s = String.valueOf(string);
            Matcher m = compiled.matcher(s);
            StringBuilder out = new StringBuilder();
            int last = 0;
            int done = 0;
            while ((max == 0 || done < max) && m.find()) {
                out.append(s, last, m.start());
                Match match = new Match(this, m, s);
                out.append(repl instanceof Function<?, ?> f
                        ? String.valueOf(((Function<Object, Object>) f).apply(match))
                        : expand(String.valueOf(repl), match));
                last = m.end();
                done++;
            }
            return out.append(s.substring(last)).toString();
        }

        /** {@code p.split(s[, maxsplit])}: the pieces, with the text of any groups between them. */
        public List<String> split(Object string, Object... maxsplit) {
            int max = maxsplit.length > 0 && maxsplit[0] != null ? ((Number) maxsplit[0]).intValue() : 0;
            String s = String.valueOf(string);
            Matcher m = compiled.matcher(s);
            List<String> out = new ArrayList<>();
            int last = 0;
            int done = 0;
            while ((max == 0 || done < max) && m.find()) {
                out.add(s.substring(last, m.start()));
                for (int k = 1; k <= groups; k++) out.add(m.group(k));
                last = m.end();
                done++;
            }
            out.add(s.substring(last));
            return out;
        }

        /** A replacement template: {@code \1}, {@code \g<1>}, {@code \g<name>} and the usual escapes. */
        private static String expand(String template, Match m) {
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < template.length(); i++) {
                char c = template.charAt(i);
                if (c != '\\' || i + 1 >= template.length()) {
                    out.append(c);
                    continue;
                }
                char n = template.charAt(++i);
                if (Character.isDigit(n)) {
                    // Python reads up to two digits as a group number.
                    int end = i + 1 < template.length() && Character.isDigit(template.charAt(i + 1)) ? i + 2 : i + 1;
                    out.append(orEmpty(m.group(Integer.parseInt(template.substring(i, end)))));
                    i = end - 1;
                } else if (n == 'g' && i + 1 < template.length() && template.charAt(i + 1) == '<') {
                    int close = template.indexOf('>', i);
                    String ref = template.substring(i + 2, close);
                    Object key = ref.chars().allMatch(Character::isDigit) ? (Object) Integer.parseInt(ref) : ref;
                    out.append(orEmpty(m.group(key)));
                    i = close;
                } else {
                    out.append(switch (n) {
                        case 'n' -> "\n";
                        case 't' -> "\t";
                        case 'r' -> "\r";
                        case '\\' -> "\\";
                        default -> "\\" + n;
                    });
                }
            }
            return out.toString();
        }

        @Override
        public String toString() {
            return "re.compile(" + Py.repr(pattern) + ")";
        }
    }

    /** A successful match: the text and position of every group, captured when it was found. */
    public static final class Match {
        private final Pattern re;
        private final String[] texts;
        private final int[] starts;
        private final int[] ends;
        /** The string that was searched. */
        public final String string;

        Match(Pattern re, Matcher m, String string) {
            this.re = re;
            this.string = string;
            int n = m.groupCount() + 1;
            texts = new String[n];
            starts = new int[n];
            ends = new int[n];
            for (int k = 0; k < n; k++) {
                texts[k] = m.group(k);
                starts[k] = m.start(k);
                ends[k] = m.end(k);
            }
        }

        /**
         * {@code m.group()} / {@code m.group(g)} / {@code m.group(g1, g2)}: {@code null} for a
         * group that did not take part.
         */
        public String group() {
            return texts[0];
        }

        public String group(Object group) {
            return texts[re.groupNumber(group)];
        }

        public Tuple group(Object first, Object second, Object... more) {
            Object[] out = new Object[2 + more.length];
            out[0] = group(first);
            out[1] = group(second);
            for (int k = 0; k < more.length; k++) out[2 + k] = group(more[k]);
            return Tuple.of(out);
        }

        /** {@code m.groups()}: every group, {@code null} for those that did not take part. */
        public Tuple groups() {
            return Tuple.of((Object[]) java.util.Arrays.copyOfRange(texts, 1, texts.length));
        }

        /** {@code m.groupdict()}: the named groups. */
        public Map<String, Object> groupdict() {
            Map<String, Object> out = new LinkedHashMap<>();
            re.groupindex.forEach((name, k) -> out.put(name, texts[k]));
            return out;
        }

        public int start(Object... group) {
            return starts[group.length == 0 ? 0 : re.groupNumber(group[0])];
        }

        public int end(Object... group) {
            return ends[group.length == 0 ? 0 : re.groupNumber(group[0])];
        }

        public Tuple span(Object... group) {
            return Tuple.of(start(group), end(group));
        }

        /** The match's pattern ({@code m.re}). */
        public Pattern re() {
            return re;
        }

        @Override
        public String toString() {
            return "<re.Match object; span=(" + start() + ", " + end() + "), match=" + Py.repr(texts[0]) + ">";
        }
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }
}
