// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * Python semantics that have no one-line Java equivalent, for code translated by Pyrite. Each
 * helper works on any value, because the translated code often cannot know a value's type.
 */
public final class Py {
    private Py() {}

    /** Python's {@code NotImplemented}: what a binary operator method returns for a type it does not handle. */
    public static final Object NotImplemented = new Object() {
        @Override
        public String toString() {
            return "NotImplemented";
        }
    };

    /** Python's {@code Ellipsis} ({@code ...}), used as a placeholder value. */
    public static final Object Ellipsis = new Object() {
        @Override
        public String toString() {
            return "Ellipsis";
        }
    };

    /**
     * Python truthiness ({@code if x:}): false for {@code None}, {@code False}, zero, and empty
     * strings, collections, maps and arrays; true for everything else.
     */
    public static boolean truthy(Object value) {
        if (value == null) return false;
        if (value instanceof Boolean b) return b;
        if (value instanceof Number n) return n.doubleValue() != 0;
        if (value instanceof CharSequence s) return s.length() > 0;
        if (value instanceof Collection<?> c) return !c.isEmpty();
        if (value instanceof Map<?, ?> m) return !m.isEmpty();
        if (value instanceof Optional<?> o) return o.isPresent();
        if (value.getClass().isArray()) return Array.getLength(value) > 0;
        return true;
    }

    /**
     * {@code seq[lo:hi]}: a slice of a string, list, tuple or array, of the same kind. Bounds may
     * be {@code null} (open), negative (from the end) or out of range (clamped), as in Python.
     */
    public static <T> T slice(T seq, Object lo, Object hi) {
        return slice(seq, lo, hi, null);
    }

    /** {@code seq[lo:hi:step]}; a negative step walks backwards. */
    @SuppressWarnings("unchecked")
    public static <T> T slice(T seq, Object lo, Object hi, Object step) {
        int n = len(seq);
        int st = step == null ? 1 : ((Number) step).intValue();
        if (st == 0) throw new IllegalArgumentException("slice step cannot be zero");
        int start = bound(lo, n, st > 0 ? 0 : n - 1, st);
        int stop = bound(hi, n, st > 0 ? n : -1, st);
        List<Integer> indexes = new ArrayList<>();
        for (int i = start; st > 0 ? i < stop : i > stop; i += st) indexes.add(i);
        if (seq instanceof CharSequence s) {
            StringBuilder sb = new StringBuilder();
            for (int i : indexes) sb.append(s.charAt(i));
            return (T) sb.toString();
        }
        if (seq.getClass().isArray()) {
            Object out = Array.newInstance(seq.getClass().getComponentType(), indexes.size());
            for (int k = 0; k < indexes.size(); k++) Array.set(out, k, Array.get(seq, indexes.get(k)));
            return (T) out;
        }
        List<?> list = (List<?>) seq;
        List<Object> out = new ArrayList<>();
        for (int i : indexes) out.add(list.get(i));
        return (T) (seq instanceof Tuple ? Tuple.of(out.toArray()) : out);
    }

    private static int bound(Object value, int n, int dflt, int step) {
        if (value == null) return dflt;
        int v = ((Number) value).intValue();
        if (v < 0) v += n;
        return step > 0 ? Math.max(0, Math.min(v, n)) : Math.max(-1, Math.min(v, n - 1));
    }

    /** {@code seq[i]} with Python's negative indexes, on a string, list, tuple or array. */
    public static Object at(Object seq, int index) {
        int n = len(seq);
        int i = index < 0 ? n + index : index;
        if (i < 0 || i >= n) throw new IndexOutOfBoundsException(index);
        if (seq instanceof CharSequence s) return String.valueOf(s.charAt(i));
        if (seq.getClass().isArray()) return Array.get(seq, i);
        return ((List<?>) seq).get(i);
    }

    /** {@code for c in s}: a string's characters, each a one-letter string. */
    public static List<String> chars(Object s) {
        return String.valueOf(s).chars().mapToObj(c -> String.valueOf((char) c)).toList();
    }

    /** {@code len(x)} for strings, collections, maps and arrays. */
    public static int len(Object value) {
        if (value instanceof CharSequence s) return s.length();
        if (value instanceof Collection<?> c) return c.size();
        if (value instanceof Map<?, ?> m) return m.size();
        if (value != null && value.getClass().isArray()) return Array.getLength(value);
        throw new IllegalArgumentException("object of type " + typeName(value) + " has no len()");
    }

    /**
     * Any Python iterable as a Java {@code Iterable}: collections, maps (their keys), strings
     * (their characters), arrays, streams and iterators.
     */
    @SuppressWarnings("unchecked")
    public static Iterable<Object> iterable(Object value) {
        if (value instanceof Iterable<?> it) return (Iterable<Object>) it;
        if (value instanceof Map<?, ?> m) return (Iterable<Object>) (Iterable<?>) m.keySet();
        if (value instanceof CharSequence s) return s.chars().mapToObj(c -> (Object) String.valueOf((char) c)).toList();
        if (value instanceof Stream<?> st) return (Iterable<Object>) (Iterable<?>) st.toList();
        if (value instanceof Iterator<?> it) return () -> (Iterator<Object>) it;
        if (value != null && value.getClass().isArray()) {
            Object[] out = new Object[Array.getLength(value)];
            for (int k = 0; k < out.length; k++) out[k] = Array.get(value, k);
            return Arrays.asList(out);
        }
        throw new IllegalArgumentException("'" + typeName(value) + "' object is not iterable");
    }

    // ---------------------------------------------------------------- str methods

    /** Python's whitespace, what {@code str.split()} and {@code str.strip()} remove: wider than {@code String.trim}. */
    private static boolean isSpace(char c) {
        // Character.isWhitespace covers \t-\r and \u001c-\u001f; isSpaceChar the Unicode spaces.
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\u0085';
    }

    /** {@code s.split()}: runs of whitespace separate the words; no empty strings. */
    public static List<String> split(Object s) {
        return split(s, null, -1);
    }

    /** {@code s.split(sep[, maxsplit])}: a literal separator (not a regex), keeping empty strings. */
    public static List<String> split(Object s, Object sep, Object... maxsplit) {
        return split(s, sep, maxsplit.length > 0 && maxsplit[0] != null ? ((Number) maxsplit[0]).intValue() : -1);
    }

    private static List<String> split(Object value, Object sep, int max) {
        String s = String.valueOf(value);
        List<String> out = new ArrayList<>();
        if (sep == null) {
            int i = 0;
            int n = s.length();
            while (true) {
                while (i < n && isSpace(s.charAt(i))) i++;
                if (i >= n) break;
                if (max >= 0 && out.size() == max) {
                    int end = n;
                    while (end > i && isSpace(s.charAt(end - 1))) end--;
                    out.add(s.substring(i, end));
                    break;
                }
                int j = i;
                while (j < n && !isSpace(s.charAt(j))) j++;
                out.add(s.substring(i, j));
                i = j;
            }
            return out;
        }
        String d = String.valueOf(sep);
        if (d.isEmpty()) throw new IllegalArgumentException("empty separator");
        int from = 0;
        for (int at = s.indexOf(d); at >= 0 && (max < 0 || out.size() < max); at = s.indexOf(d, from)) {
            out.add(s.substring(from, at));
            from = at + d.length();
        }
        out.add(s.substring(from));
        return out;
    }

    /** {@code s.rsplit(sep[, maxsplit])}: as {@code split}, counting {@code maxsplit} from the right. */
    public static List<String> rsplit(Object s, Object... sepAndMax) {
        Object sep = sepAndMax.length > 0 ? sepAndMax[0] : null;
        int max = sepAndMax.length > 1 && sepAndMax[1] != null ? ((Number) sepAndMax[1]).intValue() : -1;
        List<String> all = split(s, sep, -1);
        if (max < 0 || all.size() <= max + 1) return all;
        String text = String.valueOf(s);
        String joiner = sep == null ? null : String.valueOf(sep);
        List<String> out = new ArrayList<>(all.subList(all.size() - max, all.size()));
        if (joiner != null) {
            out.add(0, String.join(joiner, all.subList(0, all.size() - max)));
        } else {
            // Whitespace: the head keeps its inner spacing.
            int cut = text.length();
            for (int k = 0; k < max; k++) {
                while (cut > 0 && isSpace(text.charAt(cut - 1))) cut--;
                while (cut > 0 && !isSpace(text.charAt(cut - 1))) cut--;
            }
            out.add(0, strip(text.substring(0, cut)));
        }
        return out;
    }

    /** {@code s.strip()} / {@code s.strip(chars)}. */
    public static String strip(Object s, Object... chars) {
        return rstrip(lstrip(s, chars), chars);
    }

    public static String lstrip(Object s, Object... chars) {
        String t = String.valueOf(s);
        String set = chars.length > 0 && chars[0] != null ? String.valueOf(chars[0]) : null;
        int i = 0;
        while (i < t.length() && (set == null ? isSpace(t.charAt(i)) : set.indexOf(t.charAt(i)) >= 0)) i++;
        return t.substring(i);
    }

    public static String rstrip(Object s, Object... chars) {
        String t = String.valueOf(s);
        String set = chars.length > 0 && chars[0] != null ? String.valueOf(chars[0]) : null;
        int j = t.length();
        while (j > 0 && (set == null ? isSpace(t.charAt(j - 1)) : set.indexOf(t.charAt(j - 1)) >= 0)) j--;
        return t.substring(0, j);
    }

    /** {@code s.partition(sep)}: {@code (before, sep, after)}, or {@code (s, "", "")}. */
    public static Tuple partition(Object s, Object sep) {
        String t = String.valueOf(s);
        String d = String.valueOf(sep);
        int at = t.indexOf(d);
        return at < 0 ? Tuple.of(t, "", "") : Tuple.of(t.substring(0, at), d, t.substring(at + d.length()));
    }

    /** {@code s.rpartition(sep)}: at the last {@code sep}, or {@code ("", "", s)}. */
    public static Tuple rpartition(Object s, Object sep) {
        String t = String.valueOf(s);
        String d = String.valueOf(sep);
        int at = t.lastIndexOf(d);
        return at < 0 ? Tuple.of("", "", t) : Tuple.of(t.substring(0, at), d, t.substring(at + d.length()));
    }

    /** {@code s.splitlines([keepends])}: at {@code \n}, {@code \r\n}, {@code \r} and the other Unicode line breaks. */
    public static List<String> splitlines(Object s, Object... keepends) {
        String t = String.valueOf(s);
        boolean keep = keepends.length > 0 && truthy(keepends[0]);
        List<String> out = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if ("\n\r\u000b\u000c\u001c\u001d\u001e\u0085  ".indexOf(c) < 0) continue;
            int end = i;
            if (c == '\r' && i + 1 < t.length() && t.charAt(i + 1) == '\n') i++;
            out.add(t.substring(start, keep ? i + 1 : end));
            start = i + 1;
        }
        if (start < t.length()) out.add(t.substring(start));
        return out;
    }

    /** {@code x.count(item)}: occurrences of a substring in a string, or of an element in a list. */
    public static int count(Object x, Object item) {
        if (x instanceof CharSequence s) {
            String t = s.toString();
            String sub = String.valueOf(item);
            if (sub.isEmpty()) return t.length() + 1;
            int n = 0;
            for (int at = t.indexOf(sub); at >= 0; at = t.indexOf(sub, at + sub.length())) n++;
            return n;
        }
        int n = 0;
        for (Object o : iterable(x)) if (java.util.Objects.equals(o, item)) n++;
        return n;
    }

    /** {@code x.index(item)}: the first position of a substring or an element; {@code ValueError} if absent. */
    public static int index(Object x, Object item) {
        int at = x instanceof CharSequence s ? s.toString().indexOf(String.valueOf(item)) : ((List<?>) x).indexOf(item);
        if (at < 0) throw new IllegalArgumentException(repr(item) + " is not in " + typeName(x));
        return at;
    }

    public static String zfill(Object s, Object width) {
        String t = String.valueOf(s);
        int w = ((Number) width).intValue();
        if (t.length() >= w) return t;
        int sign = !t.isEmpty() && (t.charAt(0) == '-' || t.charAt(0) == '+') ? 1 : 0;
        return t.substring(0, sign) + "0".repeat(w - t.length()) + t.substring(sign);
    }

    public static String ljust(Object s, Object width, Object... fill) {
        String t = String.valueOf(s);
        int pad = ((Number) width).intValue() - t.length();
        return pad <= 0 ? t : t + fillChar(fill).repeat(pad);
    }

    public static String rjust(Object s, Object width, Object... fill) {
        String t = String.valueOf(s);
        int pad = ((Number) width).intValue() - t.length();
        return pad <= 0 ? t : fillChar(fill).repeat(pad) + t;
    }

    /** {@code s.center(width[, fill])}: where the odd padding character goes follows CPython. */
    public static String center(Object s, Object width, Object... fill) {
        String t = String.valueOf(s);
        int w = ((Number) width).intValue();
        int pad = w - t.length();
        if (pad <= 0) return t;
        int left = pad / 2 + (pad & w & 1);
        return fillChar(fill).repeat(left) + t + fillChar(fill).repeat(pad - left);
    }

    private static String fillChar(Object... fill) {
        return fill.length > 0 && fill[0] != null ? String.valueOf(fill[0]) : " ";
    }

    /** {@code s.title()}: each word starts upper case, the rest lower case. */
    public static String title(Object s) {
        StringBuilder out = new StringBuilder();
        boolean prevCased = false;
        for (char c : String.valueOf(s).toCharArray()) {
            out.append(prevCased ? Character.toLowerCase(c) : Character.toTitleCase(c));
            prevCased = Character.isLetter(c);
        }
        return out.toString();
    }

    public static String capitalize(Object s) {
        String t = String.valueOf(s);
        return t.isEmpty() ? t : Character.toUpperCase(t.charAt(0)) + t.substring(1).toLowerCase();
    }

    public static String removeprefix(Object s, Object prefix) {
        String t = String.valueOf(s);
        String p = String.valueOf(prefix);
        return t.startsWith(p) ? t.substring(p.length()) : t;
    }

    public static String removesuffix(Object s, Object suffix) {
        String t = String.valueOf(s);
        String x = String.valueOf(suffix);
        return !x.isEmpty() && t.endsWith(x) ? t.substring(0, t.length() - x.length()) : t;
    }

    public static String expandtabs(Object s, Object... tabsize) {
        int size = tabsize.length > 0 && tabsize[0] != null ? ((Number) tabsize[0]).intValue() : 8;
        StringBuilder out = new StringBuilder();
        int col = 0;
        for (char c : String.valueOf(s).toCharArray()) {
            if (c == '\t') {
                int n = size > 0 ? size - col % size : 0;
                out.append(" ".repeat(n));
                col += n;
            } else {
                out.append(c);
                col = c == '\n' || c == '\r' ? 0 : col + 1;
            }
        }
        return out.toString();
    }

    /** {@code s.encode([encoding[, errors]])}: the bytes, UTF-8 by default. */
    public static byte[] encode(Object s, Object... encoding) {
        return String.valueOf(s).getBytes(charset(encoding));
    }

    /** {@code b.decode([encoding[, errors]])}: the text, UTF-8 by default. */
    public static String decode(Object b, Object... encoding) {
        if (b instanceof CharSequence s) return s.toString();
        return new String((byte[]) b, charset(encoding));
    }

    private static java.nio.charset.Charset charset(Object... encoding) {
        String name = encoding.length > 0 && encoding[0] != null ? String.valueOf(encoding[0]) : "utf-8";
        return java.nio.charset.Charset.forName(name.replace('_', '-'));
    }

    private interface CharTest {
        boolean test(char c);
    }

    /** Python's {@code str.isX()}: true when the string is not empty and every character passes. */
    private static boolean all(Object s, CharTest test) {
        String t = String.valueOf(s);
        if (t.isEmpty()) return false;
        for (char c : t.toCharArray()) if (!test.test(c)) return false;
        return true;
    }

    public static boolean isdigit(Object s) {
        return all(s, Character::isDigit);
    }

    public static boolean isdecimal(Object s) {
        return all(s, c -> Character.getType(c) == Character.DECIMAL_DIGIT_NUMBER);
    }

    public static boolean isnumeric(Object s) {
        return all(s, c -> Character.isDigit(c) || Character.getNumericValue(c) >= 0);
    }

    public static boolean isalpha(Object s) {
        return all(s, Character::isLetter);
    }

    public static boolean isalnum(Object s) {
        return all(s, Character::isLetterOrDigit);
    }

    public static boolean isspace(Object s) {
        return all(s, Py::isSpace);
    }

    public static boolean isascii(Object s) {
        return String.valueOf(s).chars().allMatch(c -> c < 128);
    }

    /** {@code s.isupper()}: has a cased character and no lower case one. */
    public static boolean isupper(Object s) {
        String t = String.valueOf(s);
        return t.chars().anyMatch(Character::isUpperCase) && t.chars().noneMatch(Character::isLowerCase);
    }

    public static boolean islower(Object s) {
        String t = String.valueOf(s);
        return t.chars().anyMatch(Character::isLowerCase) && t.chars().noneMatch(Character::isUpperCase);
    }

    public static boolean isidentifier(Object s) {
        String t = String.valueOf(s);
        if (t.isEmpty() || !(Character.isUnicodeIdentifierStart(t.codePointAt(0)) || t.charAt(0) == '_')) return false;
        return t.codePoints().skip(1).allMatch(Py::isIdentifierPart);
    }

    private static boolean isIdentifierPart(int c) {
        return Character.isUnicodeIdentifierPart(c) && !Character.isIdentifierIgnorable(c);
    }

    // --------------------------------------------------------------- list / dict methods

    /** {@code xs.pop()}: removes and returns the last element. */
    public static Object pop(Object x) {
        if (x instanceof java.util.Deque<?> d) return d.removeLast();
        List<?> list = (List<?>) x;
        if (list.isEmpty()) throw new IndexOutOfBoundsException("pop from empty list");
        return list.remove(list.size() - 1);
    }

    /** {@code xs.pop(i)} (negative from the end) or {@code d.pop(key)}, which fails when the key is missing. */
    public static Object pop(Object x, Object key) {
        if (x instanceof Map<?, ?> m) {
            if (!m.containsKey(key)) throw new java.util.NoSuchElementException(repr(key));
            return m.remove(key);
        }
        List<?> list = (List<?>) x;
        int i = ((Number) key).intValue();
        return list.remove(i < 0 ? list.size() + i : i);
    }

    /** {@code d.pop(key, default)}. */
    public static Object pop(Object x, Object key, Object dflt) {
        Map<?, ?> m = (Map<?, ?>) x;
        return m.containsKey(key) ? m.remove(key) : dflt;
    }

    /** {@code xs.remove(value)}: removes the first equal element (by value, never by index), or fails. */
    public static void remove(Object x, Object value) {
        if (!((Collection<?>) x).remove(value)) throw new IllegalArgumentException("list.remove(x): x not in list");
    }

    /** {@code repr(x)}: strings quoted as Python quotes them, {@code None}, {@code True}/{@code False}. */
    public static String repr(Object value) {
        if (value == null) return "None";
        if (value instanceof Boolean b) return b ? "True" : "False";
        if (value instanceof CharSequence s) return "'" + s.toString().replace("\\", "\\\\").replace("'", "\\'") + "'";
        return value.toString();
    }

    private static String typeName(Object value) {
        return value == null ? "NoneType" : value.getClass().getSimpleName();
    }
}
