// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.ByteOrder;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Python's {@code sys} module (the commonly used part) for translated code. */
public final class Sys {
    private Sys() {}

    private static final String OS = System.getProperty("os.name", "").toLowerCase();

    /** {@code sys.argv}: the script name, then the arguments (see {@link #setArgv}). */
    public static final List<String> argv = new ArrayList<>(List.of(""));
    /** {@code sys.path}: kept for code that reads or extends it; Java does not search it. */
    public static final List<String> path = new ArrayList<>();
    /** {@code sys.modules}: kept for code that reads or fills it. */
    public static final Map<String, Object> modules = new HashMap<>();
    /** {@code sys.platform}: {@code "win32"}, {@code "darwin"} or {@code "linux"}. */
    public static final String platform = OS.startsWith("windows") ? "win32" : OS.contains("mac") ? "darwin" : "linux";
    public static final long maxsize = Long.MAX_VALUE;
    public static final String byteorder = ByteOrder.nativeOrder() == ByteOrder.LITTLE_ENDIAN ? "little" : "big";

    public static final TextOut stdout = new TextOut(System.out);
    public static final TextOut stderr = new TextOut(System.err);
    public static final TextIn stdin = new TextIn();

    /** Fill {@code sys.argv} from {@code main}'s arguments: {@code Sys.setArgv("prog", args)}. */
    public static void setArgv(String script, String... args) {
        argv.clear();
        argv.add(script);
        argv.addAll(List.of(args));
    }

    /** {@code sys.exit()}: status 0. */
    public static void exit() {
        exit(null);
    }

    /** {@code sys.exit(code)}: an int is the status; anything else is printed to stderr, status 1. */
    public static void exit(Object code) {
        if (code == null) System.exit(0);
        if (code instanceof Number n) System.exit(n.intValue());
        System.err.println(code);
        System.exit(1);
    }

    /** {@code sys.audit(event, *args)}: no audit hooks in Java; does nothing. */
    public static void audit(Object event, Object... args) {}

    public static int getrecursionlimit() {
        return 1000;
    }

    public static String getdefaultencoding() {
        return "utf-8";
    }

    public static String getfilesystemencoding() {
        return Charset.defaultCharset().name().toLowerCase();
    }

    public static String intern(String s) {
        return s.intern();
    }

    /** A text output stream with Python's {@code write} / {@code flush}. */
    public static final class TextOut {
        private final PrintStream out;

        TextOut(PrintStream out) {
            this.out = out;
        }

        /** {@code stream.write(s)}: returns the number of characters written. */
        public int write(Object s) {
            String text = String.valueOf(s);
            out.print(text);
            return text.length();
        }

        public void flush() {
            out.flush();
        }

        public boolean isatty() {
            return System.console() != null;
        }
    }

    /** A text input stream with Python's {@code readline} / {@code read}. */
    public static final class TextIn {
        private BufferedReader reader;

        private BufferedReader reader() {
            if (reader == null) reader = new BufferedReader(new InputStreamReader(System.in, Charset.defaultCharset()));
            return reader;
        }

        /** {@code stream.readline()}: the next line with its newline, or {@code ""} at the end. */
        public String readline() {
            try {
                String line = reader().readLine();
                return line == null ? "" : line + "\n";
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }

        /** {@code stream.read()}: everything up to the end. */
        public String read() {
            StringBuilder sb = new StringBuilder();
            for (String line = readline(); !line.isEmpty(); line = readline()) sb.append(line);
            return sb.toString();
        }

        public boolean isatty() {
            return System.console() != null;
        }
    }
}
