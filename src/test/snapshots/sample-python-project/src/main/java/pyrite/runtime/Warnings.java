// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

/**
 * Python's {@code warnings} module for translated code: warnings are printed to stderr. The
 * warning categories are nested classes, passed as {@code Warnings.DeprecationWarning.class}.
 */
@SuppressWarnings("serial")
public final class Warnings {
    private Warnings() {}

    /** Python's {@code Warning}, base of the warning categories (raised like an exception, rarely). */
    public static class Warning extends RuntimeException {
        public Warning(Object... args) {
            super(args.length == 0 ? null : String.valueOf(args[0]));
        }
    }

    public static class UserWarning extends Warning {
        public UserWarning(Object... args) {
            super(args);
        }
    }

    public static class DeprecationWarning extends Warning {
        public DeprecationWarning(Object... args) {
            super(args);
        }
    }

    public static class PendingDeprecationWarning extends Warning {
        public PendingDeprecationWarning(Object... args) {
            super(args);
        }
    }

    public static class FutureWarning extends Warning {
        public FutureWarning(Object... args) {
            super(args);
        }
    }

    public static class RuntimeWarning extends Warning {
        public RuntimeWarning(Object... args) {
            super(args);
        }
    }

    public static class SyntaxWarning extends Warning {
        public SyntaxWarning(Object... args) {
            super(args);
        }
    }

    public static class ImportWarning extends Warning {
        public ImportWarning(Object... args) {
            super(args);
        }
    }

    public static class UnicodeWarning extends Warning {
        public UnicodeWarning(Object... args) {
            super(args);
        }
    }

    public static class BytesWarning extends Warning {
        public BytesWarning(Object... args) {
            super(args);
        }
    }

    public static class ResourceWarning extends Warning {
        public ResourceWarning(Object... args) {
            super(args);
        }
    }

    public static class EncodingWarning extends Warning {
        public EncodingWarning(Object... args) {
            super(args);
        }
    }

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
