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
