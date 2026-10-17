// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

/** Python's {@code warnings} module for translated code: warnings are printed to stderr. */
public final class Warnings {
    private Warnings() {}

    /** {@code warnings.warn(message[, category, stacklevel])}: prints {@code Category: message}. */
    public static void warn(Object message, Object... categoryAndStacklevel) {
        Object category = categoryAndStacklevel.length > 0 ? categoryAndStacklevel[0] : null;
        String name = category == null ? "UserWarning" : String.valueOf(category);
        if (category instanceof Class<?> c) name = c.getSimpleName();
        System.err.println(name + ": " + message);
    }

    /** {@code warnings.simplefilter(...)}: filters are not supported; does nothing. */
    public static void simplefilter(Object... args) {}

    /** {@code warnings.filterwarnings(...)}: filters are not supported; does nothing. */
    public static void filterwarnings(Object... args) {}

    /** {@code with warnings.catch_warnings():} as a try-with-resources resource; does nothing. */
    public static AutoCloseable catch_warnings(Object... args) {
        return () -> {};
    }
}
