// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.RandomAccess;

/**
 * A Python tuple: an immutable, ordered, possibly heterogeneous sequence. As a {@link List} it
 * can be indexed ({@code t.get(0)}), iterated, streamed and compared with {@code equals}; it
 * prints like Python ({@code (1, 'a')}) and orders element by element like Python.
 */
public final class Tuple extends AbstractList<Object> implements RandomAccess, Comparable<Tuple> {
    private static final Tuple EMPTY = new Tuple(new Object[0]);

    private final Object[] items;

    private Tuple(Object[] items) {
        this.items = items;
    }

    /** {@code (a, b, c)}. An {@code Object[]} argument (star-unpacking) becomes the items. */
    public static Tuple of(Object... items) {
        return items.length == 0 ? EMPTY : new Tuple(items.clone());
    }

    /** {@code tuple(iterable)}. */
    public static Tuple from(Object iterable) {
        List<Object> list = new ArrayList<>();
        for (Object item : Py.iterable(iterable)) list.add(item);
        return new Tuple(list.toArray());
    }

    /** {@code zip(a, b, ...)}: tuples of the items at the same position, as long as the shortest input. */
    public static List<Tuple> zip(Object... iterables) {
        List<Iterator<Object>> its = new ArrayList<>();
        for (Object it : iterables) its.add(Py.iterable(it).iterator());
        List<Tuple> out = new ArrayList<>();
        while (!its.isEmpty() && its.stream().allMatch(Iterator::hasNext)) {
            Object[] row = new Object[its.size()];
            for (int k = 0; k < row.length; k++) row[k] = its.get(k).next();
            out.add(new Tuple(row));
        }
        return out;
    }

    /** {@code enumerate(iterable)}: {@code (index, item)} tuples from 0. */
    public static List<Tuple> enumerate(Object iterable) {
        return enumerate(iterable, 0);
    }

    /** {@code enumerate(iterable, start)}. */
    public static List<Tuple> enumerate(Object iterable, int start) {
        List<Tuple> out = new ArrayList<>();
        int i = start;
        for (Object item : Py.iterable(iterable)) out.add(new Tuple(new Object[] {i++, item}));
        return out;
    }

    @Override
    public Object get(int index) {
        return items[index < 0 ? items.length + index : index];
    }

    @Override
    public int size() {
        return items.length;
    }

    @Override
    public Object[] toArray() {
        return items.clone();
    }

    @Override
    @SuppressWarnings({"unchecked", "rawtypes"})
    public int compareTo(Tuple other) {
        for (int k = 0; k < Math.min(items.length, other.items.length); k++) {
            if (Objects.equals(items[k], other.items[k])) continue;
            return ((Comparable) items[k]).compareTo(other.items[k]);
        }
        return Integer.compare(items.length, other.items.length);
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("(");
        for (int k = 0; k < items.length; k++) {
            if (k > 0) sb.append(", ");
            sb.append(Py.repr(items[k]));
        }
        return sb.append(items.length == 1 ? ",)" : ")").toString();
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Tuple t ? Arrays.equals(items, t.items) : super.equals(o);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(items);
    }
}
