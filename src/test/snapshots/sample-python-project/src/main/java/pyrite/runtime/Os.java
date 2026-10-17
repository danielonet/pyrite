// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Python's {@code os} module (the commonly used part) for translated code. Paths may be given
 * as strings, {@link Path}s or {@link File}s; I/O errors are thrown as {@link UncheckedIOException}.
 */
public final class Os {
    private Os() {}

    private static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase().startsWith("windows");

    /** {@code os.environ}: a copy of the environment that the program may change. */
    public static final Map<String, String> environ = new HashMap<>(System.getenv());
    /** {@code os.name}: {@code "nt"} on Windows, {@code "posix"} elsewhere. */
    public static final String name = WINDOWS ? "nt" : "posix";
    public static final String sep = File.separator;
    public static final String altsep = WINDOWS ? "/" : null;
    public static final String pathsep = File.pathSeparator;
    public static final String linesep = System.lineSeparator();
    public static final String curdir = ".";
    public static final String pardir = "..";
    public static final String extsep = ".";
    public static final String devnull = WINDOWS ? "nul" : "/dev/null";

    /** {@code os.fspath(p)}: the path as a string. */
    public static String fspath(Object p) {
        if (p instanceof String s) return s;
        if (p instanceof Path || p instanceof File || p instanceof CharSequence) return p.toString();
        String type = p == null ? "NoneType" : p.getClass().getSimpleName();
        throw new IllegalArgumentException("expected str, bytes or os.PathLike object, not " + type);
    }

    /** {@code os.getenv(key)}: the variable, or {@code null}. */
    public static String getenv(Object key) {
        return environ.get(String.valueOf(key));
    }

    /** {@code os.getenv(key, default)}. */
    public static Object getenv(Object key, Object dflt) {
        String value = environ.get(String.valueOf(key));
        return value != null ? value : dflt;
    }

    public static String getcwd() {
        return Paths.get("").toAbsolutePath().toString();
    }

    /** {@code os.listdir()} / {@code os.listdir(p)}: the names in a directory, in no particular order. */
    public static List<String> listdir(Object... p) {
        try (Stream<Path> entries = Files.list(Path.of(p.length == 0 ? curdir : fspath(p[0])))) {
            return new ArrayList<>(entries.map(e -> e.getFileName().toString()).toList());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** {@code os.mkdir(p[, mode])}. */
    public static void mkdir(Object p, Object... mode) {
        io(() -> Files.createDirectory(Path.of(fspath(p))));
    }

    /** {@code os.makedirs(p[, mode, exist_ok])}: creates missing parents; an existing directory is accepted. */
    public static void makedirs(Object p, Object... rest) {
        io(() -> Files.createDirectories(Path.of(fspath(p))));
    }

    public static void remove(Object p) {
        io(() -> Files.delete(Path.of(fspath(p))));
    }

    public static void unlink(Object p) {
        remove(p);
    }

    public static void rmdir(Object p) {
        remove(p);
    }

    public static void rename(Object src, Object dst) {
        io(() -> Files.move(Path.of(fspath(src)), Path.of(fspath(dst))));
    }

    public static void replace(Object src, Object dst) {
        io(() -> Files.move(Path.of(fspath(src)), Path.of(fspath(dst)), StandardCopyOption.REPLACE_EXISTING));
    }

    public static long getpid() {
        return ProcessHandle.current().pid();
    }

    public static int cpu_count() {
        return Runtime.getRuntime().availableProcessors();
    }

    /** {@code os.urandom(n)}: n random bytes from a secure source. */
    public static byte[] urandom(Object n) {
        byte[] bytes = new byte[((Number) n).intValue()];
        new SecureRandom().nextBytes(bytes);
        return bytes;
    }

    private interface IoAction {
        void run() throws IOException;
    }

    private static void io(IoAction action) {
        try {
            action.run();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Python's {@code os.path}. */
    public static final class path {
        private path() {}

        /** {@code os.path.join(a, *p)}: an absolute part discards what came before it, as in Python. */
        public static String join(Object first, Object... parts) {
            StringBuilder out = new StringBuilder(fspath(first));
            for (Object part : parts) {
                String p = fspath(part);
                if (isabs(p)) out.setLength(0);
                else if (out.length() > 0 && !endsWithSep(out.toString())) out.append(sep);
                out.append(p);
            }
            return out.toString();
        }

        public static boolean exists(Object p) {
            return Files.exists(Path.of(fspath(p)));
        }

        public static boolean lexists(Object p) {
            return Files.exists(Path.of(fspath(p)), java.nio.file.LinkOption.NOFOLLOW_LINKS);
        }

        public static boolean isdir(Object p) {
            return Files.isDirectory(Path.of(fspath(p)));
        }

        public static boolean isfile(Object p) {
            return Files.isRegularFile(Path.of(fspath(p)));
        }

        public static boolean islink(Object p) {
            return Files.isSymbolicLink(Path.of(fspath(p)));
        }

        public static boolean isabs(Object p) {
            String s = fspath(p);
            return s.startsWith("/") || (WINDOWS && Path.of(s).isAbsolute());
        }

        /** {@code os.path.basename(p)}: what follows the last separator. */
        public static String basename(Object p) {
            String s = fspath(p);
            return s.substring(lastSep(s) + 1);
        }

        /**
         * {@code os.path.dirname(p)}: what precedes the last separator, without trailing
         * separators (unless it is the root).
         */
        public static String dirname(Object p) {
            String s = fspath(p);
            String head = s.substring(0, lastSep(s) + 1);
            String stripped = head.replaceAll("[" + java.util.regex.Pattern.quote(seps()) + "]+$", "");
            return stripped.isEmpty() ? head : stripped;
        }

        /** {@code os.path.split(p)}: {@code (dirname, basename)}. */
        public static Tuple split(Object p) {
            return Tuple.of(dirname(p), basename(p));
        }

        /** {@code os.path.splitext(p)}: {@code (root, ext)}; leading dots of a name are not an extension. */
        public static Tuple splitext(Object p) {
            String s = fspath(p);
            int nameStart = lastSep(s) + 1;
            int dot = s.lastIndexOf('.');
            int firstNonDot = nameStart;
            while (firstNonDot < s.length() && s.charAt(firstNonDot) == '.') firstNonDot++;
            if (dot <= nameStart || dot < firstNonDot) return Tuple.of(s, "");
            return Tuple.of(s.substring(0, dot), s.substring(dot));
        }

        public static String abspath(Object p) {
            return Path.of(fspath(p)).toAbsolutePath().normalize().toString();
        }

        public static String normpath(Object p) {
            String s = Path.of(fspath(p)).normalize().toString();
            return s.isEmpty() ? curdir : s;
        }

        /** {@code os.path.normcase(p)}: lower case with backslashes on Windows, unchanged elsewhere. */
        public static String normcase(Object p) {
            String s = fspath(p);
            return WINDOWS ? s.replace('/', '\\').toLowerCase() : s;
        }

        public static String realpath(Object p) {
            try {
                return Path.of(fspath(p)).toRealPath().toString();
            } catch (IOException e) {
                return abspath(p);
            }
        }

        /** {@code os.path.relpath(p[, start])}. */
        public static String relpath(Object p, Object... start) {
            String from = start.length == 0 || start[0] == null ? curdir : fspath(start[0]);
            Path base = Path.of(from).toAbsolutePath().normalize();
            String rel = base.relativize(Path.of(fspath(p)).toAbsolutePath().normalize()).toString();
            return rel.isEmpty() ? curdir : rel;
        }

        /** {@code os.path.expanduser(p)}: a leading {@code ~} is the user's home directory. */
        public static String expanduser(Object p) {
            String s = fspath(p);
            if (!s.equals("~") && !s.startsWith("~/") && !s.startsWith("~" + sep)) return s;
            return System.getProperty("user.home") + s.substring(1);
        }

        public static long getsize(Object p) {
            try {
                return Files.size(Path.of(fspath(p)));
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }

        /** {@code os.path.getmtime(p)}: seconds since the epoch. */
        public static double getmtime(Object p) {
            try {
                return Files.getLastModifiedTime(Path.of(fspath(p))).toMillis() / 1000.0;
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }

        private static String seps() {
            return altsep == null ? sep : sep + altsep;
        }

        private static boolean endsWithSep(String s) {
            return !s.isEmpty() && seps().indexOf(s.charAt(s.length() - 1)) >= 0;
        }

        private static int lastSep(String s) {
            int at = -1;
            for (char c : seps().toCharArray()) at = Math.max(at, s.lastIndexOf(c));
            return at;
        }
    }
}
