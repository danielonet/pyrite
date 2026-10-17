// Pyrite runtime library, copied into the Java view: do not edit.
package pyrite.runtime;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a method that was a Python {@code @property}: Python code reads it like a field
 * ({@code obj.total}), the translation calls it ({@code obj.total()}).
 */
@Documented
@Retention(RetentionPolicy.SOURCE)
@Target(ElementType.METHOD)
public @interface Property {}
