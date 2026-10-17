// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

/** Python's {@code time} module (clocks and sleeping) for translated code. */
public final class Time {
    private Time() {}

    /** {@code time.time()}: seconds since the epoch, with a fraction. */
    public static double time() {
        return System.currentTimeMillis() / 1000.0;
    }

    public static long time_ns() {
        return System.currentTimeMillis() * 1_000_000L;
    }

    /** {@code time.monotonic()} / {@code time.perf_counter()}: seconds on a clock that never goes back. */
    public static double monotonic() {
        return System.nanoTime() / 1e9;
    }

    public static double perf_counter() {
        return monotonic();
    }

    public static long perf_counter_ns() {
        return System.nanoTime();
    }

    /** {@code time.sleep(seconds)}. */
    public static void sleep(Object seconds) {
        try {
            Thread.sleep(Math.round(((Number) seconds).doubleValue() * 1000));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
